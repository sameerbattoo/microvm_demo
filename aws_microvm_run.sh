#!/usr/bin/env bash
# ============================================================
# AWS MicroVM Mode — Full Self-Contained Launch
#
# This script handles everything:
# 1. Creates IAM roles + S3 bucket (if not exists)
# 2. Builds the MicroVM image (if not exists)
# 3. Starts the token proxy (with image ARN configured)
# 4. Starts the notebook web UI
#
# New notebook tabs in the UI auto-launch MicroVM instances.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/config.sh"

cleanup() {
  echo ""
  echo ">> Shutting down proxy & UI..."
  kill $PROXY_PID 2>/dev/null || true
  kill $FRONTEND_PID 2>/dev/null || true
  echo "   MicroVMs launched by the UI are still running."
  echo "   To terminate all: bash scripts/teardown.sh"
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "============================================"
echo "  MicroVM Notebook — AWS Mode"
echo "============================================"
echo "  Region:   $AWS_REGION"
echo "  Account:  $ACCOUNT_ID"
echo "  Image:    $IMAGE_NAME"
echo ""

# --- Kill stale processes from a previous run ---
for port in $BACKEND_PORT $PROXY_PORT 5173; do
  lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
done

# --- Check dependencies ---
if command -v python3 &>/dev/null; then
  PYTHON=python3
elif command -v python &>/dev/null && [[ "$(python --version 2>&1)" == *"3."* ]]; then
  PYTHON=python
else
  echo "❌ Python 3 not found. Install python3 or ensure 'python' points to Python 3."
  exit 1
fi
echo "   Python: $($PYTHON --version)"

# Check AWS CLI version (need 2.35.10+ for lambda-microvms)
if ! command -v aws &>/dev/null; then
  echo "❌ AWS CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi

AWS_CLI_VERSION=$(aws --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
AWS_CLI_MAJOR=$(echo "$AWS_CLI_VERSION" | cut -d. -f1)
AWS_CLI_MINOR=$(echo "$AWS_CLI_VERSION" | cut -d. -f2)
AWS_CLI_PATCH=$(echo "$AWS_CLI_VERSION" | cut -d. -f3)

if [ "$AWS_CLI_MAJOR" -lt 2 ] || ([ "$AWS_CLI_MAJOR" -eq 2 ] && [ "$AWS_CLI_MINOR" -lt 35 ]) || \
   ([ "$AWS_CLI_MAJOR" -eq 2 ] && [ "$AWS_CLI_MINOR" -eq 35 ] && [ "$AWS_CLI_PATCH" -lt 10 ]); then
  echo "❌ AWS CLI version $AWS_CLI_VERSION is too old."
  echo "   Lambda MicroVMs requires AWS CLI 2.35.10+"
  echo ""
  echo "   Update with:"
  echo "   curl \"https://awscli.amazonaws.com/AWSCLIV2.pkg\" -o /tmp/AWSCLIV2.pkg"
  echo "   sudo installer -pkg /tmp/AWSCLIV2.pkg -target /"
  exit 1
fi
echo "   AWS CLI version: $AWS_CLI_VERSION ✓"

echo ">> Checking Python dependencies..."
$PYTHON -m pip install --quiet -r "$ROOT_DIR/requirements-proxy.txt" 2>/dev/null || \
  $PYTHON -m pip install --quiet --break-system-packages -r "$ROOT_DIR/requirements-proxy.txt" 2>/dev/null || \
  echo "   ⚠ Could not install Python deps automatically. Please run: pip3 install -r requirements-proxy.txt"

if ! command -v npm &>/dev/null; then
  echo "❌ npm not found."
  exit 1
fi

if [ ! -d "$ROOT_DIR/web/node_modules" ]; then
  echo ">> Installing web dependencies..."
  (cd "$ROOT_DIR/web" && npm install)
fi

# --- Ensure S3 bucket exists ---
echo ">> Checking S3 bucket: $ARTIFACT_BUCKET"
if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" 2>/dev/null; then
  echo "   Creating bucket..."
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket \
      --bucket "$ARTIFACT_BUCKET" \
      --profile "$AWS_CLI_PROFILE" \
      --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$ARTIFACT_BUCKET" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION" \
      --profile "$AWS_CLI_PROFILE" \
      --region "$AWS_REGION"
  fi
else
  echo "   Bucket exists ✓"
fi

# --- Set S3 lifecycle rule for session checkpoints (auto-delete after N days) ---
echo "   Setting lifecycle rule: sessions/ expire after ${S3_CHECKPOINT_RETENTION_DAYS} days"
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$ARTIFACT_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "ExpireSessionCheckpoints",
      "Status": "Enabled",
      "Filter": {"Prefix": "sessions/"},
      "Expiration": {"Days": '"$S3_CHECKPOINT_RETENTION_DAYS"'}
    }]
  }' \
  --profile "$AWS_CLI_PROFILE" \
  --region "$AWS_REGION" 2>/dev/null || true

# --- Ensure IAM roles exist ---
echo ">> Checking IAM roles..."
if ! aws iam get-role --role-name "$BUILD_ROLE_NAME" --profile "$AWS_CLI_PROFILE" &>/dev/null; then
  echo "   Creating build role: $BUILD_ROLE_NAME"
  aws iam create-role \
    --role-name "$BUILD_ROLE_NAME" \
    --assume-role-policy-document file://"$ROOT_DIR/iam/build-role-trust.json" \
    --profile "$AWS_CLI_PROFILE" >/dev/null

  POLICY=$(sed "s/\${ARTIFACT_BUCKET}/$ARTIFACT_BUCKET/g" "$ROOT_DIR/iam/build-role-permissions.json")
  aws iam put-role-policy \
    --role-name "$BUILD_ROLE_NAME" \
    --policy-name "BuildPolicy" \
    --policy-document "$POLICY" \
    --profile "$AWS_CLI_PROFILE"

  echo "   Waiting 10s for IAM propagation..."
  sleep 10
else
  echo "   Build role exists ✓"
fi

if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" --profile "$AWS_CLI_PROFILE" &>/dev/null; then
  echo "   Creating exec role: $EXEC_ROLE_NAME"
  aws iam create-role \
    --role-name "$EXEC_ROLE_NAME" \
    --assume-role-policy-document file://"$ROOT_DIR/iam/exec-role-trust.json" \
    --profile "$AWS_CLI_PROFILE" >/dev/null
else
  echo "   Exec role exists ✓"
fi

# Always update the exec role policy (picks up permission changes)
aws iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "ExecPolicy" \
  --policy-document file://"$ROOT_DIR/iam/exec-role-permissions.json" \
  --profile "$AWS_CLI_PROFILE"

# --- Setup sample data (DynamoDB + S3) ---
bash "$ROOT_DIR/scripts/setup_sample_data.sh"

# --- Ensure MicroVM images exist (all size tiers) ---
echo ">> Checking MicroVM images..."
NEEDS_BUILD=false
for MEM in $IMAGE_SIZES; do
  TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${IMAGE_NAME}-${MEM}"
  STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
    --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$STATE" != "CREATED" ]; then
    NEEDS_BUILD=true
    break
  fi
done

if [ "$NEEDS_BUILD" = "true" ]; then
  echo "   Some images missing — building all tiers..."
  bash "$ROOT_DIR/scripts/build_all_images.sh"
else
  echo "   All image tiers ready ✓"
fi

# --- Start token proxy ---
echo ""
echo ">> Starting token proxy on http://localhost:$PROXY_PORT"
(cd "$ROOT_DIR" && \
  MICROVM_IMAGE_ARN="$IMAGE_ARN" \
  MICROVM_EXEC_ROLE_ARN="$EXEC_ROLE_ARN" \
  AWS_REGION="$AWS_REGION" \
  POLL_INTERVAL_MS="$POLL_INTERVAL_MS" \
  ATHENA_DB="$ATHENA_DB" \
  ATHENA_WORKGROUP="$ATHENA_WORKGROUP" \
  ARTIFACT_BUCKET="$ARTIFACT_BUCKET" \
  DYNAMO_TABLE="$DYNAMO_TABLE" \
  STORAGE_BACKEND="$STORAGE_BACKEND" \
  STORAGE_CONNECTION="$STORAGE_CONNECTION" \
  PRICE_RUNNING_PER_GB_SEC="$PRICE_RUNNING_PER_GB_SEC" \
  PRICE_SUSPENDED_PER_GB_SEC="$PRICE_SUSPENDED_PER_GB_SEC" \
  METRICS_RETENTION_HOURS="$METRICS_RETENTION_HOURS" \
  $PYTHON -m uvicorn proxy.server:app --host 0.0.0.0 --port "$PROXY_PORT" --log-level warning) &
PROXY_PID=$!
sleep 1

# --- Start frontend ---
echo ">> Starting notebook UI on http://localhost:5173"
(cd "$ROOT_DIR/web" && VITE_PROXY_PORT="$PROXY_PORT" npm run dev -- --open) &
FRONTEND_PID=$!

echo ""
echo "============================================"
echo "  ✅ All running!"
echo ""
echo "  Notebook UI:    http://localhost:5173"
echo "  Token Proxy:    http://localhost:$PROXY_PORT"
echo "  MicroVM Image:  $IMAGE_ARN"
echo ""
echo "  New notebook tabs auto-launch their own MicroVM."
echo "  Closing a tab terminates its MicroVM."
echo ""
echo "  Press Ctrl+C to stop proxy & UI"
echo "============================================"
echo ""

wait
