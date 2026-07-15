#!/usr/bin/env bash
# ============================================================
# Setup sample data sources (DynamoDB table + S3 sample file)
# Called from aws_microvm_run.sh and dev_run.sh
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

DYNAMO_TABLE="microvm-demo-data"
SAMPLE_S3_KEY="samples/sales_data.csv"

echo ">> Setting up sample data sources..."

# --- DynamoDB Table ---
echo "   Checking DynamoDB table: $DYNAMO_TABLE"
TABLE_STATUS=$(aws dynamodb describe-table --table-name "$DYNAMO_TABLE" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$TABLE_STATUS" = "NOT_FOUND" ]; then
  echo "   Creating DynamoDB table..."
  aws dynamodb create-table \
    --table-name "$DYNAMO_TABLE" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null

  echo "   Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists --table-name "$DYNAMO_TABLE" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"

  echo "   Populating with sample data..."
  aws dynamodb batch-write-item \
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

# --- S3 Sample File ---
echo "   Checking S3 sample file: s3://$ARTIFACT_BUCKET/$SAMPLE_S3_KEY"
if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$SAMPLE_S3_KEY" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" 2>/dev/null; then
  echo "   Uploading sample CSV to S3..."
  aws s3 cp "$ROOT_DIR/web/public/samples/data/sales_data.csv" \
    "s3://$ARTIFACT_BUCKET/$SAMPLE_S3_KEY" \
    --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null
  echo "   Sample CSV uploaded to S3 ✓"
else
  echo "   S3 sample file exists ✓"
fi

# --- Update exec role with DynamoDB + S3 permissions ---
echo "   Updating execution role permissions..."
aws iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "ExecPolicy" \
  --policy-document file://"$ROOT_DIR/iam/exec-role-permissions.json" \
  --profile "$AWS_CLI_PROFILE" >/dev/null
echo "   Execution role updated (S3 + DynamoDB + STS) ✓"

echo "   Sample data setup complete ✓"
