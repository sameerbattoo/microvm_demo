#!/usr/bin/env bash
# ============================================================
# Setup IAM roles and S3 bucket for Lambda MicroVM sandbox
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo "============================================"
echo "  Lambda MicroVM Sandbox — IAM & S3 Setup"
echo "============================================"
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $AWS_REGION"
echo "  Bucket:   $ARTIFACT_BUCKET"
echo ""

# --- S3 Bucket ---
echo ">> Creating S3 bucket: $ARTIFACT_BUCKET"
if [ "$AWS_REGION" = "us-east-1" ]; then
  aws s3api create-bucket \
    --bucket "$ARTIFACT_BUCKET" \
    --profile "$AWS_CLI_PROFILE" \
    --region "$AWS_REGION" 2>/dev/null || echo "   (bucket already exists)"
else
  aws s3api create-bucket \
    --bucket "$ARTIFACT_BUCKET" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION" \
    --profile "$AWS_CLI_PROFILE" \
    --region "$AWS_REGION" 2>/dev/null || echo "   (bucket already exists)"
fi

# --- Build Role ---
echo ">> Creating build role: $BUILD_ROLE_NAME"
aws iam create-role \
  --role-name "$BUILD_ROLE_NAME" \
  --assume-role-policy-document file://"$ROOT_DIR/iam/build-role-trust.json" \
  --profile "$AWS_CLI_PROFILE" 2>/dev/null || echo "   (role already exists)"

# Substitute bucket name into permissions policy
POLICY=$(sed "s/\${ARTIFACT_BUCKET}/$ARTIFACT_BUCKET/g" "$ROOT_DIR/iam/build-role-permissions.json")
aws iam put-role-policy \
  --role-name "$BUILD_ROLE_NAME" \
  --policy-name "BuildPolicy" \
  --policy-document "$POLICY" \
  --profile "$AWS_CLI_PROFILE"

# --- Execution Role ---
echo ">> Creating execution role: $EXEC_ROLE_NAME"
aws iam create-role \
  --role-name "$EXEC_ROLE_NAME" \
  --assume-role-policy-document file://"$ROOT_DIR/iam/exec-role-trust.json" \
  --profile "$AWS_CLI_PROFILE" 2>/dev/null || echo "   (role already exists)"

aws iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "ExecPolicy" \
  --policy-document file://"$ROOT_DIR/iam/exec-role-permissions.json" \
  --profile "$AWS_CLI_PROFILE"

echo ""
echo "✅ Setup complete. Wait ~10 seconds for IAM propagation, then run:"
echo "   bash scripts/build_all_images.sh"
