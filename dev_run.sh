#!/usr/bin/env bash
# ============================================================
# Local Development Mode
# Starts both the sandbox backend and the notebook web UI
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/config.sh"

cleanup() {
  echo ""
  echo ">> Shutting down..."
  kill $BACKEND_PID 2>/dev/null || true
  kill $FRONTEND_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "============================================"
echo "  MicroVM Notebook — Local Dev Mode"
echo "============================================"
echo ""

# --- Check and install dependencies ---
if ! command -v python3 &>/dev/null; then
  echo "❌ python3 not found. Install Python 3.11+"
  exit 1
fi

echo ">> Checking Python dependencies..."
python3 -m pip install --quiet fastapi uvicorn "boto3>=1.43.40" 2>/dev/null || \
  python3 -m pip install --quiet --break-system-packages fastapi uvicorn "boto3>=1.43.40" 2>/dev/null || \
  echo "   ⚠ Could not install Python deps automatically. Please install: pip3 install fastapi uvicorn 'boto3>=1.43.40'"

if ! command -v npm &>/dev/null; then
  echo "❌ npm not found. Install Node.js 18+"
  exit 1
fi

if [ ! -d "$ROOT_DIR/web/node_modules" ]; then
  echo ">> Installing web dependencies..."
  (cd "$ROOT_DIR/web" && npm install)
else
  echo ">> Web dependencies already installed."
fi

# --- Setup sample data (optional — requires AWS credentials) ---
if aws sts get-caller-identity --profile "${AWS_CLI_PROFILE:-default}" &>/dev/null; then
  echo ">> AWS credentials found — setting up sample data..."
  bash "$ROOT_DIR/scripts/setup_sample_data.sh" 2>/dev/null || echo "   (skipped — non-critical)"
else
  echo ">> No AWS credentials — skipping sample data setup (DynamoDB, S3)"
fi

# --- Start backend ---
echo ">> Starting sandbox backend on http://localhost:$BACKEND_PORT"
(cd "$ROOT_DIR" && python3 -m uvicorn app.server:app --host 0.0.0.0 --port "$BACKEND_PORT") &
BACKEND_PID=$!

sleep 1

# --- Start frontend ---
echo ">> Starting notebook UI on http://localhost:5173"
(cd "$ROOT_DIR/web" && VITE_PROXY_PORT="$PROXY_PORT" npm run dev -- --open) &
FRONTEND_PID=$!

echo ""
echo "============================================"
echo "  ✅ Running!"
echo ""
echo "  Notebook UI:  http://localhost:5173"
echo "  Sandbox API:  http://localhost:$BACKEND_PORT"
echo ""
echo "  Click 'Local Dev Mode' in the UI to connect."
echo "  Press Ctrl+C to stop both servers."
echo "============================================"
echo ""

wait
