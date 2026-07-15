#!/usr/bin/env bash
# ============================================================
# Terminate the running MicroVM sandbox
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

if [ ! -f "$ROOT_DIR/.microvm" ]; then
  echo "No .microvm file found — nothing to terminate."
  exit 0
fi
source "$ROOT_DIR/.microvm"

echo "============================================"
echo "  Lambda MicroVM Sandbox — Teardown"
echo "============================================"
echo "   MicroVM ID: $MICROVM_ID"
echo ""

echo ">> Terminating MicroVM..."
aws_mvm terminate-microvm --microvm-identifier "$MICROVM_ID" 2>/dev/null || true

echo ">> Waiting for TERMINATED state..."
for i in {1..12}; do
  state=$(aws_mvm get-microvm --microvm-identifier "$MICROVM_ID" \
    --query 'state' --output text 2>/dev/null || echo "TERMINATED")
  echo "   state=$state"
  [ "$state" = "TERMINATED" ] && break
  sleep 5
done

rm -f "$ROOT_DIR/.microvm"

echo ""
echo "✅ Sandbox terminated. No further charges."
echo ""
echo "   To also delete the image:"
echo "   aws lambda-microvms delete-microvm-image --image-identifier $IMAGE_ARN --region $AWS_REGION"
