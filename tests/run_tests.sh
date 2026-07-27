#!/usr/bin/env bash
# Run all tests based on the proxy's current persistence mode.
# Requires: proxy running (aws_microvm_run.sh)
set -euo pipefail

PROXY_URL="http://localhost:8081"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASSED=0
FAILED=0
SKIPPED=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo "============================================"
echo "  MicroVM Test Suite"
echo "============================================"
echo ""

# Check proxy
echo ">> Checking proxy..."
HEALTH=$(curl -s "$PROXY_URL/health" 2>/dev/null || echo "")
if [ -z "$HEALTH" ]; then
    echo "  ❌ Proxy not reachable at $PROXY_URL"
    echo "  Run: ./aws_microvm_run.sh"
    exit 1
fi

MODE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('persistence_mode','unknown'))")
MAX_LIFE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('max_lifetime_seconds',0))")
echo "  Mode: $MODE"
echo "  Max Lifetime: ${MAX_LIFE}s"
echo ""

run_test() {
    local test_file="$1"
    local test_name=$(basename "$test_file" .py)
    echo -n "  Running $test_name... "
    if python3 "$test_file" > "/tmp/test_${test_name}.log" 2>&1; then
        echo -e "${GREEN}PASSED${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}FAILED${NC} (see /tmp/test_${test_name}.log)"
        FAILED=$((FAILED + 1))
    fi
}

# Common tests
echo ">> Common tests (mode-agnostic)"
for test_file in "$SCRIPT_DIR"/common/test_*.py; do
    [ -f "$test_file" ] && run_test "$test_file"
done
echo ""

# Mode-specific tests
if [ "$MODE" = "eternal" ]; then
    echo ">> Eternal mode tests"
    for test_file in "$SCRIPT_DIR"/eternal/test_*.py; do
        [ -f "$test_file" ] && run_test "$test_file"
    done
elif [ "$MODE" = "checkpoint" ]; then
    echo ">> Checkpoint mode tests"
    for test_file in "$SCRIPT_DIR"/checkpoint/test_*.py; do
        [ -f "$test_file" ] && run_test "$test_file"
    done
else
    echo "  ⚠ Unknown mode: $MODE — skipping mode-specific tests"
    SKIPPED=$((SKIPPED + 1))
fi

echo ""
echo "============================================"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}, $SKIPPED skipped"
echo "============================================"
[ $FAILED -eq 0 ] || exit 1
