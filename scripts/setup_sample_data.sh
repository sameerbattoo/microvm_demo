#!/usr/bin/env bash
# ============================================================
# Setup sample data sources (DynamoDB + S3 + Athena)
# Called from aws_microvm_run.sh and dev_run.sh
#
# Idempotent: safe to run multiple times. Checks for existing
# resources before creating. Retries transient AWS errors.
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

DYNAMO_TABLE="${DYNAMO_TABLE}"
ATHENA_DB="${ATHENA_DB}"
ATHENA_WORKGROUP="${ATHENA_WORKGROUP}"
ATHENA_RESULTS_PREFIX="athena-results"

# All sample CSV files to upload
SAMPLE_CSV_FILES=(
  "sales_data.csv"
  "ab_test_results.csv"
  "customers.csv"
  "web_traffic.csv"
)

# --- Retry helper ---
# Usage: retry <max_attempts> <delay_seconds> <command...>
retry() {
  local max_attempts=$1; shift
  local delay=$1; shift
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ $attempt -ge $max_attempts ]; then
      echo "   ⚠ Command failed after $max_attempts attempts: $*"
      return 1
    fi
    echo "   ⚠ Attempt $attempt failed, retrying in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

echo ">> Setting up sample data sources..."

# ============================================================
# DynamoDB Table
# ============================================================
echo "   Checking DynamoDB table: $DYNAMO_TABLE"
TABLE_STATUS=$(aws dynamodb describe-table --table-name "$DYNAMO_TABLE" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$TABLE_STATUS" = "NOT_FOUND" ]; then
  echo "   Creating DynamoDB table..."
  retry 3 5 aws dynamodb create-table \
    --table-name "$DYNAMO_TABLE" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null

  echo "   Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists --table-name "$DYNAMO_TABLE" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"

  echo "   Populating with sample data..."
  retry 3 5 aws dynamodb batch-write-item \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
    --request-items '{
      "'$DYNAMO_TABLE'": [
        {"PutRequest":{"Item":{"id":{"S":"PROD-001"},"name":{"S":"Laptop Pro 16"},"category":{"S":"Electronics"},"price":{"N":"1299.99"},"stock":{"N":"142"},"rating":{"N":"4.7"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-002"},"name":{"S":"Wireless Headphones"},"category":{"S":"Electronics"},"price":{"N":"199.99"},"stock":{"N":"523"},"rating":{"N":"4.3"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-003"},"name":{"S":"Standing Desk"},"category":{"S":"Furniture"},"price":{"N":"549.00"},"stock":{"N":"67"},"rating":{"N":"4.8"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-004"},"name":{"S":"4K Monitor 27in"},"category":{"S":"Electronics"},"price":{"N":"449.99"},"stock":{"N":"231"},"rating":{"N":"4.5"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-005"},"name":{"S":"Ergonomic Chair"},"category":{"S":"Furniture"},"price":{"N":"399.00"},"stock":{"N":"89"},"rating":{"N":"4.6"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-006"},"name":{"S":"Mechanical Keyboard"},"category":{"S":"Electronics"},"price":{"N":"149.99"},"stock":{"N":"312"},"rating":{"N":"4.4"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-007"},"name":{"S":"USB-C Hub"},"category":{"S":"Accessories"},"price":{"N":"79.99"},"stock":{"N":"891"},"rating":{"N":"4.2"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-008"},"name":{"S":"Webcam HD"},"category":{"S":"Electronics"},"price":{"N":"129.99"},"stock":{"N":"445"},"rating":{"N":"4.1"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-009"},"name":{"S":"Desk Lamp LED"},"category":{"S":"Furniture"},"price":{"N":"59.99"},"stock":{"N":"678"},"rating":{"N":"4.3"}}}},
        {"PutRequest":{"Item":{"id":{"S":"PROD-010"},"name":{"S":"Notebook Stand"},"category":{"S":"Accessories"},"price":{"N":"39.99"},"stock":{"N":"1204"},"rating":{"N":"4.0"}}}}
      ]
    }' >/dev/null

  echo "   DynamoDB table created with 10 sample products ✓"
else
  echo "   DynamoDB table exists ($TABLE_STATUS) ✓"
fi

# ============================================================
# S3 Sample Files (flat — for sidebar S3 listing)
# ============================================================
echo "   Uploading sample CSV files to S3..."
for csv_file in "${SAMPLE_CSV_FILES[@]}"; do
  S3_KEY="samples/${csv_file}"
  if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$S3_KEY" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" 2>/dev/null; then
    retry 3 3 aws s3 cp "$ROOT_DIR/web/public/samples/data/${csv_file}" \
      "s3://$ARTIFACT_BUCKET/$S3_KEY" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
    echo "   Uploaded ${csv_file} ✓"
  else
    echo "   ${csv_file} exists ✓"
  fi
done

# ============================================================
# S3 Per-Table Prefixes (for Athena external tables)
# ============================================================
echo "   Copying CSVs to per-table S3 prefixes for Athena..."
for csv_file in "${SAMPLE_CSV_FILES[@]}"; do
  table_name="${csv_file%.csv}"
  TABLE_KEY="samples/${table_name}/${csv_file}"
  if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$TABLE_KEY" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" 2>/dev/null; then
    retry 3 3 aws s3 cp "$ROOT_DIR/web/public/samples/data/${csv_file}" \
      "s3://$ARTIFACT_BUCKET/$TABLE_KEY" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
    echo "   Copied to samples/${table_name}/ ✓"
  else
    echo "   samples/${table_name}/${csv_file} exists ✓"
  fi
done

# Ensure athena-results prefix exists
aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "${ATHENA_RESULTS_PREFIX}/" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 || true

# ============================================================
# Athena Workgroup (with default output location)
# Must exist before we run queries so we can use it as default
# ============================================================
echo "   Checking Athena workgroup: $ATHENA_WORKGROUP"
WG_STATE=$(aws athena get-work-group --work-group "$ATHENA_WORKGROUP" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'WorkGroup.State' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$WG_STATE" = "NOT_FOUND" ]; then
  echo "   Creating workgroup..."
  retry 3 5 aws athena create-work-group \
    --name "$ATHENA_WORKGROUP" \
    --configuration '{"ResultConfiguration":{"OutputLocation":"s3://'"$ARTIFACT_BUCKET"'/'"$ATHENA_RESULTS_PREFIX"'/"},"EnforceWorkGroupConfiguration":false}' \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  echo "   Workgroup created ✓"
else
  echo "   Workgroup exists ($WG_STATE) ✓"
fi

# ============================================================
# Athena Database + Tables
# ============================================================
echo "   Setting up Athena database and tables..."
ATHENA_OUTPUT="s3://${ARTIFACT_BUCKET}/${ATHENA_RESULTS_PREFIX}/"

# Helper: run an Athena query, wait for completion, retry on transient failure
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
      echo "   ⚠ Failed to start query (attempt $attempt/$max_retries)"
      attempt=$((attempt + 1))
      sleep 5
      continue
    fi

    # Wait for query to complete (max 90 seconds)
    local status="RUNNING"
    local wait_count=0
    while [ "$status" = "RUNNING" ] || [ "$status" = "QUEUED" ]; do
      sleep 2
      status=$(aws athena get-query-execution \
        --query-execution-id "$execution_id" \
        --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
        --query 'QueryExecution.Status.State' --output text 2>/dev/null || echo "RUNNING")
      wait_count=$((wait_count + 1))
      if [ $wait_count -ge 45 ]; then
        echo "   ⚠ Query timed out: $execution_id"
        status="TIMED_OUT"
        break
      fi
    done

    if [ "$status" = "SUCCEEDED" ]; then
      return 0
    fi

    # Get failure reason
    local reason
    reason=$(aws athena get-query-execution \
      --query-execution-id "$execution_id" \
      --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
      --query 'QueryExecution.Status.StateChangeReason' --output text 2>/dev/null || echo "unknown")

    # If it's "already exists" that's fine (idempotent)
    if echo "$reason" | grep -qi "already exists"; then
      return 0
    fi

    echo "   ⚠ Query $status (attempt $attempt/$max_retries): $reason"
    attempt=$((attempt + 1))
    sleep 5
  done

  echo "   ❌ Query failed after $max_retries attempts"
  return 1
}

# Create database
echo "   Creating Athena database: $ATHENA_DB"
run_athena_query "CREATE DATABASE IF NOT EXISTS ${ATHENA_DB}"

# Create table: sales_data
echo "   Creating table: sales_data"
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.sales_data (
  order_id STRING,
  date STRING,
  product STRING,
  region STRING,
  quantity INT,
  unit_price DOUBLE,
  discount DOUBLE,
  customer_id STRING
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/sales_data/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

# Create table: ab_test_results
echo "   Creating table: ab_test_results"
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.ab_test_results (
  user_id STRING,
  group_name STRING,
  converted INT,
  time_on_page_sec DOUBLE,
  pages_viewed INT,
  revenue DOUBLE
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/ab_test_results/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

# Create table: customers
echo "   Creating table: customers"
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.customers (
  customer_id STRING,
  name STRING,
  email STRING,
  age INT,
  country STRING,
  signup_date STRING,
  lifetime_value DOUBLE
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/customers/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

# Create table: web_traffic
echo "   Creating table: web_traffic"
run_athena_query "
CREATE EXTERNAL TABLE IF NOT EXISTS ${ATHENA_DB}.web_traffic (
  date STRING,
  visitors INT,
  page_views INT,
  bounce_rate DOUBLE,
  avg_session_min DOUBLE
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 's3://${ARTIFACT_BUCKET}/samples/web_traffic/'
TBLPROPERTIES ('skip.header.line.count'='1')
"

echo "   Athena setup complete ✓"

# ============================================================
# Update Execution Role
# ============================================================
echo "   Updating execution role permissions..."
retry 3 5 aws iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "ExecPolicy" \
  --policy-document file://"$ROOT_DIR/iam/exec-role-permissions.json" \
  --profile "$AWS_CLI_PROFILE" >/dev/null
echo "   Execution role updated (S3 + DynamoDB + Athena + STS) ✓"

echo "   Sample data setup complete ✓"
