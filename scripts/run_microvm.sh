#!/usr/bin/env bash
# ============================================================
# Launch a MicroVM sandbox instance
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo "============================================"
echo "  Lambda MicroVM Sandbox — Run"
echo "============================================"

SESSION_ID="${1:-session-$(date +%s)}"
echo ">> Session ID: $SESSION_ID"

# --- Run the MicroVM ---
echo ">> Launching MicroVM from image: $IMAGE_NAME"
run_json=$(aws_mvm run-microvm \
  --image-identifier "$IMAGE_ARN" \
  --execution-role-arn "$EXEC_ROLE_ARN" \
  --ingress-network-connectors "$INGRESS_CONNECTOR" \
  --egress-network-connectors "$EGRESS_CONNECTOR" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":300,"suspendedDurationSeconds":1800}' \
  --maximum-duration-in-seconds 28800 \
  --run-hook-payload "$SESSION_ID")

MICROVM_ID=$(echo "$run_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["microvmId"])')
ENDPOINT=$(echo "$run_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["endpoint"])')

echo "   MicroVM ID: $MICROVM_ID"
echo "   Endpoint:   $ENDPOINT"

# --- Poll until RUNNING ---
echo ">> Waiting for RUNNING state..."
while true; do
  state=$(aws_mvm get-microvm --microvm-identifier "$MICROVM_ID" \
    --query 'state' --output text)
  echo "   state=$state"
  [ "$state" = "RUNNING" ] && break
  sleep 5
done

# --- Save for other scripts ---
cat > "$ROOT_DIR/.microvm" <<EOF
MICROVM_ID=$MICROVM_ID
ENDPOINT=$ENDPOINT
SESSION_ID=$SESSION_ID
EOF

echo ""
echo "✅ Sandbox is running!"
echo "   Endpoint: https://$ENDPOINT"
echo "   Saved to .microvm"
echo ""
echo "   Idle policy: suspend after 5 min, terminate after 30 min suspended"
echo "   Max duration: 8 hours"
echo ""
echo "   Next: bash scripts/trigger.sh execute '{\"code\": \"print(42)\"}'"
