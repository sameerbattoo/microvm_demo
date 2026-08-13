#!/usr/bin/env bash
# ============================================================
# Setup e-commerce sample data sources (DynamoDB + S3 + Athena)
# Called from aws_microvm_run.sh and dev_run.sh
#
# E-commerce scenario:
#   DynamoDB: product-reviews (5000+), product-recommendations (1000)
#   Athena:   orders, customers, products (via S3 CSV + Glue)
#   S3:       clickstream_events.csv, marketing_campaigns.csv, inventory_daily.csv
#   Local:    sales_targets_q3.csv, competitor_prices.csv (uploaded to VM at launch)
#
# Idempotent: safe to run multiple times. Cleans old data first.
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

ATHENA_RESULTS_PREFIX="athena-results"

# DynamoDB table names
REVIEWS_TABLE="ecommerce-reviews"
RECOMMENDATIONS_TABLE="ecommerce-recommendations"

# S3 files to upload to samples/ prefix (for Data Sources panel)
S3_SAMPLE_FILES=(
  "clickstream_events.csv"
  "marketing_campaigns.csv"
  "inventory_daily.csv"
)

# Athena table source files (uploaded to per-table S3 prefixes)
ATHENA_TABLE_FILES=(
  "orders.csv"
  "customers.csv"
  "products.csv"
)

# --- Retry helper ---
retry() {
  local max_attempts=$1; shift
  local delay=$1; shift
  local attempt=1
  while true; do
    if "$@"; then return 0; fi
    if [ $attempt -ge $max_attempts ]; then
      echo "   ⚠ Command failed after $max_attempts attempts: $*"
      return 1
    fi
    echo "   ⚠ Attempt $attempt failed, retrying in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

echo ">> Setting up e-commerce sample data sources..."

# ============================================================
# S3: Clean old samples and upload new ones
# ============================================================
echo "   Cleaning old S3 sample data..."
aws s3 rm "s3://$ARTIFACT_BUCKET/samples/" --recursive \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" 2>/dev/null || true

echo "   Generating and uploading S3 sample files..."
python3 -c "
import csv, random
random.seed(99)

# --- clickstream_events.csv (10000 rows) ---
actions = ['page_view', 'add_to_cart', 'purchase', 'search', 'wishlist', 'remove_from_cart', 'review']
devices = ['desktop', 'mobile', 'tablet']
pages = ['/home', '/products', '/cart', '/checkout', '/search', '/account', '/deals']
with open('/tmp/_s3_clickstream_events.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['event_id','user_id','session_id','action','page','product_id','device','timestamp','duration_seconds'])
    for i in range(1, 10001):
        w.writerow([f'EVT-{i:06d}', f'USR-{random.randint(1,500):04d}', f'SESS-{random.randint(1,2000):05d}', random.choice(actions), random.choice(pages), f'PROD-{random.randint(1,100):04d}' if random.random()>0.3 else '', random.choice(devices), f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}Z', random.randint(1,300)])

# --- marketing_campaigns.csv (20 rows) ---
channels = ['email', 'social_media', 'search_ads', 'display', 'influencer', 'affiliate']
with open('/tmp/_s3_marketing_campaigns.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['campaign_id','name','channel','start_date','end_date','budget','spend','impressions','clicks','conversions','revenue'])
    for i in range(1, 21):
        budget = random.randint(5000, 50000)
        spend = round(budget * random.uniform(0.6, 1.0))
        impressions = random.randint(50000, 500000)
        clicks = int(impressions * random.uniform(0.01, 0.05))
        conversions = int(clicks * random.uniform(0.02, 0.15))
        w.writerow([f'CMP-{i:03d}', f'Campaign {i}', random.choice(channels), f'2024-{random.randint(1,6):02d}-01', f'2024-{random.randint(7,12):02d}-30', budget, spend, impressions, clicks, conversions, round(conversions*random.uniform(30,150),2)])

# --- inventory_daily.csv (500 rows) ---
warehouses = ['WH-EAST', 'WH-WEST', 'WH-CENTRAL', 'WH-EU']
with open('/tmp/_s3_inventory_daily.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['date','product_id','warehouse','quantity_on_hand','quantity_reserved','reorder_point','days_of_supply'])
    for i in range(500):
        w.writerow([f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}', f'PROD-{random.randint(1,100):04d}', random.choice(warehouses), random.randint(0,500), random.randint(0,50), random.randint(10,100), random.randint(0,45)])

print('   Generated S3 sample CSVs in /tmp')
"

for csv_file in "${S3_SAMPLE_FILES[@]}"; do
  retry 3 3 aws s3 cp "/tmp/_s3_${csv_file}" \
    "s3://$ARTIFACT_BUCKET/samples/${csv_file}" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  echo "   ✓ samples/${csv_file}"
done
rm -f /tmp/_s3_clickstream_events.csv /tmp/_s3_marketing_campaigns.csv /tmp/_s3_inventory_daily.csv

echo "   Uploading Athena table CSV files..."
# Generate Athena table CSVs in /tmp and upload to S3
python3 -c "
import csv, random, os
random.seed(42)

# ============================================================
# SHARED CONSTANTS — used across all tables for consistency
# ============================================================
COUNTRIES = ['US', 'UK', 'DE', 'FR', 'JP', 'AU', 'CA', 'MX', 'BR', 'IN']
CATEGORIES = ['Electronics', 'Clothing', 'Home & Kitchen', 'Sports', 'Books', 'Food & Grocery', 'Beauty', 'Toys']
BRANDS = ['TechPro', 'StyleCraft', 'HomeEssentials', 'SportFit', 'ReadMore', 'FreshChoice', 'GlowUp', 'PlayTime']
SEGMENTS = ['Premium', 'Standard', 'New', 'At-Risk', 'Churned']
SIGNUP_CHANNELS = ['organic', 'paid_search', 'social', 'referral', 'email', 'direct']
PAYMENT_METHODS = ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'crypto']

# ============================================================
# orders.csv (2000 rows)
# Schema: order_id, user_id, product_id, quantity, unit_price, total, order_date, shipping_country, payment_method
# ============================================================
with open('/tmp/_athena_orders.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['order_id','user_id','product_id','quantity','unit_price','total','order_date','shipping_country','payment_method'])
    for i in range(1, 2001):
        qty = random.randint(1, 5)
        price = round(random.uniform(5.0, 200.0), 2)
        w.writerow([f'ORD-{i:05d}', f'USR-{random.randint(1,500):04d}', f'PROD-{random.randint(1,100):04d}',
                    qty, price, round(qty*price, 2),
                    f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
                    random.choice(COUNTRIES), random.choice(PAYMENT_METHODS)])

# ============================================================
# customers.csv (500 rows)
# Schema: user_id, name, email, phone, signup_date, signup_channel, segment, lifetime_value
# ============================================================
first_names = ['James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda','David','Elizabeth',
               'William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen']
last_names = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
              'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin']
with open('/tmp/_athena_customers.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['user_id','name','email','phone','signup_date','signup_channel','segment','lifetime_value'])
    for i in range(1, 501):
        fname = random.choice(first_names)
        lname = random.choice(last_names)
        w.writerow([f'USR-{i:04d}', f'{fname} {lname}', f'{fname.lower()}.{lname.lower()}{i}@example.com',
                    f'+1-{random.randint(200,999)}-{random.randint(100,999)}-{random.randint(1000,9999)}',
                    f'20{random.randint(20,25):02d}-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
                    random.choice(SIGNUP_CHANNELS), random.choice(SEGMENTS),
                    round(random.uniform(10,5000),2)])

# ============================================================
# products.csv (100 rows)
# Schema: product_id, name, category, brand, price, cost, stock_quantity, rating_avg
# ============================================================
with open('/tmp/_athena_products.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['product_id','name','category','brand','price','cost','stock_quantity','rating_avg'])
    for i in range(1, 101):
        cat_idx = (i - 1) % len(CATEGORIES)
        cat = CATEGORIES[cat_idx]
        brand = BRANDS[cat_idx]
        price = round(random.uniform(5.0, 300.0), 2)
        w.writerow([f'PROD-{i:04d}', f'{brand} {cat} Item {i}', cat, brand,
                    price, round(price*random.uniform(0.3,0.7),2),
                    random.randint(0,500), round(random.uniform(1.0,5.0),1)])

print('   Generated Athena source CSVs in /tmp')
"

for csv_file in "${ATHENA_TABLE_FILES[@]}"; do
  table_name="${csv_file%.csv}"
  retry 3 3 aws s3 cp "/tmp/_athena_${csv_file}" \
    "s3://$ARTIFACT_BUCKET/samples/${table_name}/${csv_file}" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  echo "   ✓ samples/${table_name}/${csv_file}"
done
rm -f /tmp/_athena_orders.csv /tmp/_athena_customers.csv /tmp/_athena_products.csv

# Ensure athena-results prefix exists
aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "${ATHENA_RESULTS_PREFIX}/" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 || true

# ============================================================
# DynamoDB: Product Reviews Table
# ============================================================
echo "   Checking DynamoDB table: $REVIEWS_TABLE"
TABLE_STATUS=$(aws dynamodb describe-table --table-name "$REVIEWS_TABLE" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$TABLE_STATUS" = "NOT_FOUND" ]; then
  echo "   Creating $REVIEWS_TABLE..."
  retry 3 5 aws dynamodb create-table \
    --table-name "$REVIEWS_TABLE" \
    --attribute-definitions \
      AttributeName=productId,AttributeType=S \
      AttributeName=reviewId,AttributeType=S \
    --key-schema \
      AttributeName=productId,KeyType=HASH \
      AttributeName=reviewId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$REVIEWS_TABLE" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"
  echo "   Populating reviews..."
  # Generate 25 reviews via batch-write (DynamoDB limit: 25 per batch)
  python3 -c "
import boto3, json, random, time
from decimal import Decimal
session = boto3.Session(profile_name='$AWS_CLI_PROFILE', region_name='$AWS_REGION')
ddb = session.resource('dynamodb')
table = ddb.Table('$REVIEWS_TABLE')
titles = ['Great product!', 'Not bad', 'Amazing quality', 'Disappointed', 'Exceeded expectations', 'Good value', 'Poor packaging', 'Fast delivery', 'Worth every penny', 'Average']
texts = ['Really love this product. Would buy again.', 'It works but could be better.', 'Top notch quality and design.', 'Broke after 2 weeks of use.', 'Better than expected for the price.', 'Good for the price point.', 'Arrived damaged, returned.', 'Quick shipping, product as described.', 'Best purchase this year.', 'Does the job, nothing special.']
random.seed(42)
with table.batch_writer() as batch:
    for i in range(200):
        batch.put_item(Item={
            'productId': f'PROD-{random.randint(1,100):04d}',
            'reviewId': f'REV-{i+1:05d}',
            'userId': f'USR-{random.randint(1,500):04d}',
            'rating': Decimal(str(random.randint(1,5))),
            'title': random.choice(titles),
            'text': random.choice(texts),
            'helpful_votes': Decimal(str(random.randint(0,50))),
            'verified_purchase': random.choice([True, False]),
            'review_date': f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
        })
print(f'   Inserted 200 reviews into $REVIEWS_TABLE')
"
  echo "   $REVIEWS_TABLE created ✓"
else
  echo "   $REVIEWS_TABLE exists ($TABLE_STATUS) ✓"
fi

# ============================================================
# DynamoDB: Product Recommendations Table
# ============================================================
echo "   Checking DynamoDB table: $RECOMMENDATIONS_TABLE"
TABLE_STATUS=$(aws dynamodb describe-table --table-name "$RECOMMENDATIONS_TABLE" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$TABLE_STATUS" = "NOT_FOUND" ]; then
  echo "   Creating $RECOMMENDATIONS_TABLE..."
  retry 3 5 aws dynamodb create-table \
    --table-name "$RECOMMENDATIONS_TABLE" \
    --attribute-definitions \
      AttributeName=userId,AttributeType=S \
      AttributeName=productId,AttributeType=S \
    --key-schema \
      AttributeName=userId,KeyType=HASH \
      AttributeName=productId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$RECOMMENDATIONS_TABLE" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"
  echo "   Populating recommendations..."
  python3 -c "
import boto3, random
from decimal import Decimal
session = boto3.Session(profile_name='$AWS_CLI_PROFILE', region_name='$AWS_REGION')
ddb = session.resource('dynamodb')
table = ddb.Table('$RECOMMENDATIONS_TABLE')
algorithms = ['collaborative_filtering', 'content_based', 'hybrid', 'popularity']
random.seed(123)
with table.batch_writer() as batch:
    for i in range(100):
        user_id = f'USR-{random.randint(1,500):04d}'
        num_recs = random.randint(3, 8)
        product_ids = random.sample(range(1, 101), num_recs)
        for pid in product_ids:
            batch.put_item(Item={
                'userId': user_id,
                'productId': f'PROD-{pid:04d}',
                'score': Decimal(str(round(random.uniform(0.3, 0.99), 3))),
                'algorithm': random.choice(algorithms),
                'generated_at': '2025-07-01',
            })
print(f'   Inserted ~500 recommendations into $RECOMMENDATIONS_TABLE')
"
  echo "   $RECOMMENDATIONS_TABLE created ✓"
else
  echo "   $RECOMMENDATIONS_TABLE exists ($TABLE_STATUS) ✓"
fi

# ============================================================
# Delete legacy DynamoDB table (no longer needed)
# ============================================================
echo "   Checking legacy DynamoDB table: $LEGACY_DYNAMO_TABLE"
LEGACY_STATUS=$(aws dynamodb describe-table --table-name "$LEGACY_DYNAMO_TABLE" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")
if [ "$LEGACY_STATUS" != "NOT_FOUND" ]; then
  echo "   Deleting legacy table $LEGACY_DYNAMO_TABLE..."
  aws dynamodb delete-table --table-name "$LEGACY_DYNAMO_TABLE" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 || true
  echo "   Legacy table deleted ✓"
fi
# ============================================================
# Athena Workgroup
# ============================================================
ATHENA_OUTPUT="s3://${ARTIFACT_BUCKET}/${ATHENA_RESULTS_PREFIX}/"
echo "   Checking Athena workgroup: $ATHENA_WORKGROUP"
WG_STATE=$(aws athena get-work-group --work-group "$ATHENA_WORKGROUP" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'WorkGroup.State' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$WG_STATE" = "NOT_FOUND" ]; then
  echo "   Creating Athena workgroup..."
  retry 3 5 aws athena create-work-group \
    --name "$ATHENA_WORKGROUP" \
    --configuration "ResultConfiguration={OutputLocation=$ATHENA_OUTPUT}" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  echo "   Workgroup created ✓"
else
  echo "   Workgroup exists ($WG_STATE) ✓"
fi

# ============================================================
# Athena Database + Tables
# ============================================================
echo "   Setting up Athena database and tables..."

run_athena_query() {
  local query="$1"
  local max_retries=3
  local attempt=1
  while [ $attempt -le $max_retries ]; do
    local execution_id
    execution_id=$(aws athena start-query-execution \
      --query-string "$query" \
      --work-group "$ATHENA_WORKGROUP" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
      --query 'QueryExecutionId' --output text 2>/dev/null || echo "")
    if [ -z "$execution_id" ]; then
      attempt=$((attempt + 1)); sleep 5; continue
    fi
    local status="RUNNING"
    local wait_count=0
    while [ "$status" = "RUNNING" ] || [ "$status" = "QUEUED" ]; do
      sleep 2
      status=$(aws athena get-query-execution \
        --query-execution-id "$execution_id" \
        --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
        --query 'QueryExecution.Status.State' --output text 2>/dev/null || echo "RUNNING")
      wait_count=$((wait_count + 1))
      if [ $wait_count -ge 45 ]; then status="TIMED_OUT"; break; fi
    done
    if [ "$status" = "SUCCEEDED" ]; then return 0; fi
    local reason
    reason=$(aws athena get-query-execution --query-execution-id "$execution_id" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
      --query 'QueryExecution.Status.StateChangeReason' --output text 2>/dev/null || echo "unknown")
    if echo "$reason" | grep -qi "already exists"; then return 0; fi
    attempt=$((attempt + 1)); sleep 5
  done
  return 1
}

# Drop and recreate tables (clean slate)
echo "   Creating Athena database: $ATHENA_DB"
run_athena_query "CREATE DATABASE IF NOT EXISTS ${ATHENA_DB}"


# Drop old legacy tables
echo "   Dropping legacy tables (sales_data, ab_test_results, web_traffic)..."
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.sales_data" 2>/dev/null || true
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.ab_test_results" 2>/dev/null || true
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.web_traffic" 2>/dev/null || true

echo "   Creating table: orders"
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.orders" 2>/dev/null || true
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.orders (
  order_id STRING,
  user_id STRING,
  product_id STRING,
  quantity INT,
  unit_price DOUBLE,
  total DOUBLE,
  order_date STRING,
  shipping_country STRING,
  payment_method STRING
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/orders/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

echo "   Creating table: customers"
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.customers" 2>/dev/null || true
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.customers (
  user_id STRING,
  name STRING,
  email STRING,
  phone STRING,
  signup_date STRING,
  signup_channel STRING,
  segment STRING,
  lifetime_value DOUBLE
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/customers/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

echo "   Creating table: products"
run_athena_query "DROP TABLE IF EXISTS ${ATHENA_DB}.products" 2>/dev/null || true
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.products (
  product_id STRING,
  name STRING,
  category STRING,
  brand STRING,
  price DOUBLE,
  cost DOUBLE,
  stock_quantity INT,
  rating_avg DOUBLE
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/products/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

echo "   Athena setup complete ✓"

# ============================================================
# Update Execution Role (add new DynamoDB tables)
# ============================================================
echo "   Updating execution role permissions..."
retry 3 5 aws iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "ExecPolicy" \
  --policy-document file://"$ROOT_DIR/iam/exec-role-permissions.json" \
  --profile "$AWS_CLI_PROFILE" >/dev/null
echo "   Execution role updated ✓"

echo "   E-commerce sample data setup complete ✓"
