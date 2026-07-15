#!/usr/bin/env bash
# ============================================================
# Send requests to the running MicroVM sandbox
#
# Usage:
#   bash scripts/trigger.sh execute '{"code": "x = 42\nprint(x)"}'
#   bash scripts/trigger.sh install '{"package": "pandas"}'
#   bash scripts/trigger.sh variables
#   bash scripts/trigger.sh health
#   bash scripts/trigger.sh reset
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# Load saved MicroVM info
if [ ! -f "$ROOT_DIR/.microvm" ]; then
  echo "❌ No running MicroVM found. Run: bash scripts/run_microvm.sh"
  exit 1
fi
source "$ROOT_DIR/.microvm"

ACTION="${1:-health}"
BODY="${2:-}"

# --- Get auth token ---
token=$(aws_mvm create-microvm-auth-token \
  --microvm-identifier "$MICROVM_ID" \
  --expiration-in-minutes 30 \
  --allowed-ports '[{"allPorts":{}}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)

# --- Route to endpoint ---
case "$ACTION" in
  execute)
    echo "▶ Executing code..."
    curl -sS "https://$ENDPOINT/execute" \
      -H "X-aws-proxy-auth: $token" \
      -H "Content-Type: application/json" \
      -d "$BODY" | python3 -m json.tool
    ;;
  install)
    echo "📦 Installing package..."
    curl -sS "https://$ENDPOINT/install" \
      -H "X-aws-proxy-auth: $token" \
      -H "Content-Type: application/json" \
      -d "$BODY" | python3 -m json.tool
    ;;
  variables)
    echo "📋 Listing variables..."
    curl -sS "https://$ENDPOINT/variables" \
      -H "X-aws-proxy-auth: $token" | python3 -m json.tool
    ;;
  health)
    echo "❤️  Health check..."
    curl -sS "https://$ENDPOINT/health" \
      -H "X-aws-proxy-auth: $token" | python3 -m json.tool
    ;;
  reset)
    echo "🔄 Resetting sandbox..."
    curl -sS -X POST "https://$ENDPOINT/reset" \
      -H "X-aws-proxy-auth: $token" | python3 -m json.tool
    ;;
  *)
    echo "Unknown action: $ACTION"
    echo "Usage: trigger.sh [execute|install|variables|health|reset] [body]"
    exit 1
    ;;
esac
