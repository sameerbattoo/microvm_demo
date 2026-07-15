#!/usr/bin/env bash
# ============================================================
# Build MicroVM images for all size tiers
# Creates one image per memory size (same code, different resources)
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo "============================================"
echo "  Building MicroVM images (all sizes)"
echo "============================================"

cd "$ROOT_DIR"

# Package app once
echo ">> Packaging app.zip"
rm -f app.zip
zip -r app.zip app/ Dockerfile requirements.txt >/dev/null
echo "   Created app.zip"

# Upload once
echo ">> Uploading to s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY"
aws s3 cp app.zip "s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null

# Query base image version
BASE_IMAGE_VERSION=$(aws_mvm list-managed-microvm-image-versions \
  --image-identifier "$BASE_IMAGE_ARN" \
  --query 'items[0].imageVersion' --output text 2>/dev/null || echo "0")
echo "   Base image version: $BASE_IMAGE_VERSION"

# Build each size tier
for MEM in $IMAGE_SIZES; do
  VCPU=$((MEM / 2048))
  [ $VCPU -lt 1 ] && VCPU=1
  TIER_NAME="${IMAGE_NAME}-${MEM}"
  TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"

  # Check if already exists
  TIER_STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
    --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$TIER_STATE" = "CREATED" ]; then
    echo "   ✓ ${TIER_NAME} (${MEM}MB / ${VCPU}vCPU) — already exists"
    continue
  fi

  if [ "$TIER_STATE" = "CREATING" ]; then
    echo "   ⏳ ${TIER_NAME} — already building"
    continue
  fi

  echo ">> Creating image: ${TIER_NAME} (${MEM}MB / ${VCPU}vCPU)"
  aws_mvm create-microvm-image \
    --name "$TIER_NAME" \
    --base-image-arn "$BASE_IMAGE_ARN" \
    --base-image-version "$BASE_IMAGE_VERSION" \
    --build-role-arn "$BUILD_ROLE_ARN" \
    --code-artifact "uri=s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" \
    --hooks '{"port":8080,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":30,"resume":"ENABLED","resumeTimeoutInSeconds":10,"suspend":"ENABLED","suspendTimeoutInSeconds":10,"terminate":"ENABLED","terminateTimeoutInSeconds":10},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":60}}' \
    --resources "[{\"minimumMemoryInMiB\":${MEM}}]" >/dev/null
done

# Poll until all are CREATED
echo ""
echo ">> Waiting for all images to reach CREATED state..."
ALL_READY=false
while [ "$ALL_READY" = "false" ]; do
  ALL_READY=true
  for MEM in $IMAGE_SIZES; do
    TIER_NAME="${IMAGE_NAME}-${MEM}"
    TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"
    STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
      --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")
    
    if [ "$STATE" = "CREATE_FAILED" ]; then
      echo "   ❌ ${TIER_NAME} FAILED"
      exit 1
    fi
    
    if [ "$STATE" != "CREATED" ]; then
      ALL_READY=false
    fi
  done

  if [ "$ALL_READY" = "false" ]; then
    echo "   $(date +%H:%M:%S) still building..."
    sleep 10
  fi
done

rm -f app.zip

echo ""
echo "✅ All images ready:"
for MEM in $IMAGE_SIZES; do
  VCPU=$((MEM / 2048))
  [ $VCPU -lt 1 ] && VCPU=1
  echo "   ${IMAGE_NAME}-${MEM}: $((MEM/1024)) GB / ${VCPU} vCPU"
done
