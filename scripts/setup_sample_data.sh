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
# Realistic: actions weighted by frequency (page_view most common, purchase rarest),
# product_id null for non-product actions (search, account), timestamps follow
# a realistic daily pattern (more traffic during business hours)
actions_weighted = ['page_view'] * 40 + ['search'] * 20 + ['add_to_cart'] * 15 + ['wishlist'] * 8 + ['remove_from_cart'] * 7 + ['purchase'] * 7 + ['review'] * 3
devices_weighted = ['mobile'] * 50 + ['desktop'] * 35 + ['tablet'] * 15
pages = ['/home', '/products', '/cart', '/checkout', '/search', '/account', '/deals']
with open('/tmp/_s3_clickstream_events.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['event_id','user_id','session_id','action','page','product_id','device','timestamp','duration_seconds'])
    for i in range(1, 10001):
        action = random.choice(actions_weighted)
        # product_id is null for non-product-specific actions
        has_product = action in ('add_to_cart', 'purchase', 'wishlist', 'remove_from_cart', 'review') or (action == 'page_view' and random.random() > 0.4)
        product_id = f'PROD-{random.randint(1,100):04d}' if has_product else ''
        # Realistic hour distribution (peak 9am-9pm)
        hour = random.choices(range(24), weights=[1,1,1,1,1,2,3,5,8,10,10,9,8,9,10,10,9,8,7,6,4,3,2,1])[0]
        month = random.randint(1,12)
        day = random.randint(1,28)
        w.writerow([f'EVT-{i:06d}', f'USR-{random.randint(1,500):04d}', f'SESS-{random.randint(1,2000):05d}',
                    action, random.choice(pages), product_id, random.choice(devices_weighted),
                    f'2024-{month:02d}-{day:02d}T{hour:02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}Z',
                    random.randint(1,300)])

# --- marketing_campaigns.csv (20 rows) ---
# Realistic campaign names, seasonal patterns, and budget/performance correlation
channels = ['email', 'social_media', 'search_ads', 'display', 'influencer', 'affiliate']
campaign_themes = ['Summer Sale', 'Back to School', 'Black Friday', 'Holiday Gift Guide',
                   'New Year Clearance', 'Spring Collection', 'Flash Deal Weekend', 'Loyalty Rewards',
                   'Product Launch', 'Brand Awareness', 'Retargeting', 'Win-Back',
                   'Free Shipping Promo', 'Bundle Deals', 'VIP Early Access', 'Seasonal Markdown',
                   'Category Spotlight', 'Influencer Collab', 'Referral Bonus', 'Anniversary Sale']
with open('/tmp/_s3_marketing_campaigns.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['campaign_id','name','channel','start_date','end_date','budget','spend','impressions','clicks','conversions','revenue'])
    for i in range(1, 21):
        channel = random.choice(channels)
        budget = random.randint(5000, 50000)
        # Spend correlates with budget (80-100% utilization is realistic)
        spend = round(budget * random.uniform(0.75, 0.99))
        # Impressions scale with spend: roughly 5-20 CPM
        impressions = int(spend / random.uniform(5, 20) * 1000)
        # Clicks: 1-4% CTR
        clicks = int(impressions * random.uniform(0.01, 0.04))
        # Conversions: 2-10% of clicks
        conversions = max(1, int(clicks * random.uniform(0.02, 0.10)))
        # Revenue: 40-120 average order value per conversion
        revenue = round(conversions * random.uniform(40, 120), 2)
        start_month = random.randint(1, 6)
        w.writerow([f'CMP-{i:03d}', campaign_themes[i-1], channel,
                    f'2024-{start_month:02d}-{random.randint(1,15):02d}',
                    f'2024-{start_month + random.randint(1,3):02d}-{random.randint(15,28):02d}',
                    budget, spend, impressions, clicks, conversions, revenue])

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
               'William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen',
               'Christopher','Nancy','Daniel','Lisa','Matthew','Betty','Anthony','Margaret','Mark','Sandra',
               'Donald','Ashley','Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle',
               'Kenneth','Carol','Kevin','Amanda','Brian','Dorothy','George','Melissa','Timothy','Deborah',
               'Ronald','Stephanie','Edward','Rebecca','Jason','Sharon','Jeffrey','Laura','Ryan','Cynthia']
last_names = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
              'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
              'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
              'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores']
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
  echo "   $REVIEWS_TABLE created ✓"
else
  echo "   $REVIEWS_TABLE exists ($TABLE_STATUS) ✓"
fi

# Always (re)populate reviews so the LATEST generation logic applies on every run
# Purge-then-write so the table always ends with exactly the latest generated rows.
# (We can't rely on put_item overwriting in place: the composite key includes a random
# productId, and changes to the generation logic shift the RNG stream, producing new
# keys that would accumulate alongside old rows. So we delete everything first.)
echo "   (Re)populating reviews in $REVIEWS_TABLE..."
python3 -c "
import boto3, json, random, time
from decimal import Decimal
session = boto3.Session(profile_name='$AWS_CLI_PROFILE', region_name='$AWS_REGION')
ddb = session.resource('dynamodb')
table = ddb.Table('$REVIEWS_TABLE')

# --- Purge existing rows first (clean slate) ---
_key_names = [k['AttributeName'] for k in table.key_schema]
_deleted = 0
_resp = table.scan(ProjectionExpression=', '.join(_key_names))
_existing = _resp['Items']
while 'LastEvaluatedKey' in _resp:
    _resp = table.scan(ProjectionExpression=', '.join(_key_names), ExclusiveStartKey=_resp['LastEvaluatedKey'])
    _existing += _resp['Items']
with table.batch_writer() as _b:
    for _it in _existing:
        _b.delete_item(Key={k: _it[k] for k in _key_names})
        _deleted += 1
print(f'   Purged {_deleted} existing rows from $REVIEWS_TABLE')

# Reviews are COMPOSED from sentence fragments (opener + detail + closer) rather than
# picked from a fixed list of full sentences. This makes review text genuinely
# high-cardinality — ~unique per row — so profilers don't (correctly) flag it as
# templated/synthetic. Fragments are rating-correlated so sentiment still matches the score.
#
# Titles are likewise composed from an adjective + noun-phrase template.
review_openers = {
    'positive': [
        'Really impressed with this', 'Absolutely thrilled with the purchase', 'Genuinely happy with it',
        'Exceeded my expectations', 'Could not be happier', 'Blown away by the quality',
        'So glad I finally bought this', 'This has been a fantastic buy', 'Delighted with how it turned out',
        'A wonderful addition to my setup', 'Honestly one of my better purchases',
    ],
    'neutral': [
        'It is a reasonable product', 'Does roughly what I expected', 'A fairly average experience overall',
        'Not bad for the money', 'Somewhere in the middle for me', 'It gets the basic job done',
        'A perfectly okay option', 'Middling but functional', 'Neither impressed nor disappointed',
    ],
    'negative': [
        'Pretty disappointed with this', 'Regret buying this one', 'Frustrated with the whole experience',
        'This did not work out for me', 'A letdown from the start', 'Would not recommend it',
        'Unhappy with the purchase', 'Expected much more than this', 'A frustrating waste of money',
    ],
}
review_details = {
    'positive': [
        'the build quality feels premium and solid', 'it arrived quickly and exactly as described',
        'setup took only a few minutes', 'it has held up well after months of daily use',
        'the design is sleek and genuinely functional', 'it outperforms options that cost twice as much',
        'the materials feel durable and well made', 'every detail seems carefully thought through',
        'it fits perfectly into my daily routine', 'the value for the price is hard to beat',
    ],
    'neutral': [
        'it does the basics but lacks premium features', 'the finish is okay but nothing special',
        'shipping was slower than I would have liked', 'it works, though the instructions were sparse',
        'some parts feel sturdier than others', 'it is fine for light, occasional use',
        'the size is smaller than I pictured', 'performance is acceptable for the price',
    ],
    'negative': [
        'it stopped working after a couple of weeks', 'the material feels flimsy and cheap',
        'it arrived with visible scratches and dents', 'it overheats after a short period of use',
        'the photos make it look far better than it is', 'it was incompatible with my setup despite the listing',
        'customer support was unhelpful when I reached out', 'parts started falling apart almost immediately',
        'it makes an odd noise that no review mentioned',
    ],
}
review_closers = {
    'positive': [
        'Would absolutely buy again.', 'Highly recommend it to anyone.', 'Five stars, no complaints.',
        'My whole family loves it now.', 'Worth every penny.', 'Could not ask for more.', '',
    ],
    'neutral': [
        'Might try a different brand next time.', 'Fine for what it is.', 'No strong feelings either way.',
        'Take that for what it is worth.', 'Would consider it again on sale.', '',
    ],
    'negative': [
        'Returned it within days.', 'Save your money.', 'Would not buy again.',
        'Definitely not worth the price.', 'Look elsewhere.', 'Very frustrating overall.', '',
    ],
}
title_adjectives = {
    'positive': ['Excellent', 'Fantastic', 'Outstanding', 'Impressive', 'Superb', 'Great', 'Love this'],
    'neutral': ['Decent', 'Average', 'Okay', 'Fair', 'Reasonable', 'Middling'],
    'negative': ['Disappointing', 'Poor', 'Frustrating', 'Underwhelming', 'Regrettable', 'Cheap'],
}
title_nouns = ['quality', 'value', 'purchase', 'product', 'buy', 'experience', 'build', 'choice']

def compose_review(sentiment):
    opener = random.choice(review_openers[sentiment])
    detail = random.choice(review_details[sentiment])
    closer = random.choice(review_closers[sentiment])
    # NOTE: single-quoted f-strings only — this whole block is inside a double-quoted
    # python3 -c \"...\" heredoc, so any inner double quote would close it and break the shell.
    text = f'{opener} \u2014 {detail}.'
    if closer:
        text += f' {closer}'
    title = f'{random.choice(title_adjectives[sentiment])} {random.choice(title_nouns)}'
    return title, text

random.seed(42)
with table.batch_writer() as batch:
    for i in range(200):
        rating = random.randint(1, 5)
        if rating >= 4:
            sentiment = 'positive'
        elif rating == 3:
            sentiment = 'neutral'
        else:
            sentiment = 'negative'
        title, text = compose_review(sentiment)
        batch.put_item(Item={
            'productId': f'PROD-{random.randint(1,100):04d}',
            'reviewId': f'REV-{i+1:05d}',
            'userId': f'USR-{random.randint(1,500):04d}',
            'rating': Decimal(str(rating)),
            'title': title,
            'text': text,
            'helpful_votes': Decimal(str(random.randint(0,50))),
            'verified_purchase': random.choice([True, False]),
            'review_date': f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
        })
print(f'   Inserted 200 reviews into $REVIEWS_TABLE')
"

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
            # Spread generated_at across a 6-month range (realistic model retraining cadence)
            month = random.randint(1, 6)
            day = random.randint(1, 28)
            batch.put_item(Item={
                'userId': user_id,
                'productId': f'PROD-{pid:04d}',
                'score': Decimal(str(round(random.uniform(0.3, 0.99), 3))),
                'algorithm': random.choice(algorithms),
                'generated_at': f'2025-{month:02d}-{day:02d}',
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
  order_date DATE,
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
  signup_date DATE,
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
