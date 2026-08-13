#!/usr/bin/env bash
# ============================================================
# Full Teardown — Terminate all MicroVMs and delete all images
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo "============================================"
echo "  Lambda MicroVM Sandbox — Full Teardown"
echo "============================================"
echo "   Region:  $AWS_REGION"
echo "   Account: $ACCOUNT_ID"
echo ""

# --- Terminate all running/suspended MicroVMs ---
echo ">> Listing MicroVMs..."
MICROVM_IDS=$(aws_mvm list-microvms --query 'items[?state!=`TERMINATED`].microvmId' --output text 2>/dev/null || echo "")

if [ -z "$MICROVM_IDS" ] || [ "$MICROVM_IDS" = "None" ]; then
  echo "   No active MicroVMs found."
else
  for MICROVM_ID in $MICROVM_IDS; do
    echo "   Terminating $MICROVM_ID..."
    aws_mvm terminate-microvm --microvm-identifier "$MICROVM_ID" 2>/dev/null || true
  done

  echo ">> Waiting for all to reach TERMINATED state..."
  sleep 5
  for MICROVM_ID in $MICROVM_IDS; do
    for i in {1..6}; do
      state=$(aws_mvm get-microvm --microvm-identifier "$MICROVM_ID" \
        --query 'state' --output text 2>/dev/null || echo "TERMINATED")
      [ "$state" = "TERMINATED" ] && break
      sleep 5
    done
    echo "   $MICROVM_ID → TERMINATED"
  done
fi

echo ""

# --- Delete all image tiers ---
echo ">> Deleting MicroVM images..."
for MEM in $IMAGE_SIZES; do
  TIER_NAME="${IMAGE_NAME}-${MEM}"
  TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"

  STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
    --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$STATE" = "NOT_FOUND" ] || [ "$STATE" = "DELETED" ]; then
    echo "   $TIER_NAME — not found (already deleted)"
    continue
  fi

  echo "   Deleting $TIER_NAME (state: $STATE)..."
  aws_mvm delete-microvm-image --image-identifier "$TIER_ARN" 2>/dev/null || true
done

# Wait for images to finish deleting
echo ">> Waiting for image deletion..."
sleep 5
ALL_DELETED=true
for MEM in $IMAGE_SIZES; do
  TIER_NAME="${IMAGE_NAME}-${MEM}"
  TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"
  STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
    --query 'state' --output text 2>/dev/null || echo "DELETED")
  if [ "$STATE" != "DELETED" ] && [ "$STATE" != "NOT_FOUND" ]; then
    echo "   $TIER_NAME still deleting ($STATE)..."
    ALL_DELETED=false
  else
    echo "   $TIER_NAME ✓ deleted"
  fi
done

# Clean up local state file if it exists
rm -f "$ROOT_DIR/.microvm"

echo ""
echo "============================================"
if [ "$ALL_DELETED" = "true" ]; then
  echo "  ✅ Full teardown complete."
else
  echo "  ⚠️  MicroVMs terminated. Some images still deleting (async)."
fi
echo ""
echo "  Resources cleaned:"
echo "    • All MicroVMs terminated"
echo "    • All image tiers deleted (${IMAGE_SIZES})"
echo ""
echo "  Resources NOT deleted (manual cleanup if needed):"
echo "    • S3 bucket: $ARTIFACT_BUCKET"
echo "    • IAM roles: $BUILD_ROLE_NAME, $EXEC_ROLE_NAME"
echo "    • DynamoDB tables: ecommerce-reviews, ecommerce-recommendations"
echo "    • Athena DB: $ATHENA_DB"
echo "============================================"
