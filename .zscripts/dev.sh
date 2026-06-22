#!/bin/bash

set -euo pipefail

# 获取脚本所在目录（.zscripts）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
	local step_name="$1"
	echo "=========================================="
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
	echo "=========================================="
	export STEP_START_TIME
	STEP_START_TIME=$(date +%s)
}

log_step_end() {
	local step_name="${1:-Unknown step}"
	local end_time
	end_time=$(date +%s)
	local duration=$((end_time - STEP_START_TIME))
	echo "=========================================="
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
	echo "[LOG] Step: $step_name | Duration: ${duration}s"
	echo "=========================================="
	echo ""
}

wait_for_service() {
	local host="$1"
	local port="$2"
	local service_name="$3"
	local max_attempts="${4:-60}"
	local attempt=1

	echo "Waiting for $service_name to be ready on $host:$port..."

	while [ "$attempt" -le "$max_attempts" ]; do
		if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
			echo "$service_name is ready!"
			return 0
		fi

		echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
		sleep 1
		attempt=$((attempt + 1))
	done

	echo "ERROR: $service_name failed to start within $max_attempts seconds"
	return 1
}

cleanup() {
	if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
		echo "Stopping Next.js dev server (PID: $DEV_PID)..."
		kill "$DEV_PID" >/dev/null 2>&1 || true
	fi
	if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
		echo "Stopping Python backend (PID: $BACKEND_PID)..."
		kill "$BACKEND_PID" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

# ─── Check prerequisites ───────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
	echo "ERROR: bun is not installed or not in PATH"
	exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
	echo "ERROR: python3 is not installed or not in PATH"
	exit 1
fi

# ─── Create .env if missing ─────────────────────────────────────────────────
if [ ! -f ".env" ]; then
	echo "Creating .env from .env.example..."
	cp .env.example .env
	# Fix DATABASE_URL to use absolute path
	sed -i "s|DATABASE_URL=file:.*|DATABASE_URL=file:$PROJECT_DIR/db/custom.db|" .env
fi

# ─── Create database directory ──────────────────────────────────────────────
mkdir -p db

# ─── Install Node dependencies ──────────────────────────────────────────────
log_step_start "bun install"
echo "[BUN] Installing dependencies..."
bun install
log_step_end "bun install"

# ─── Setup database ─────────────────────────────────────────────────────────
log_step_start "bun run db:push"
echo "[BUN] Setting up database..."
bun run db:push
log_step_end "bun run db:push"

# ─── Start Python backend ───────────────────────────────────────────────────
log_step_start "Starting Python backend"
echo "[PYTHON] Starting AI Pipeline backend on port 3003..."

# Use system python3 (which has all deps installed)
PYTHON_DIR="$PROJECT_DIR/mini-services/ai-pipeline-python"
cd "$PYTHON_DIR"

# Start the backend
python3 -m uvicorn app.main:socket_app --host 0.0.0.0 --port 3003 --reload >"$PROJECT_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "[PYTHON] Backend started (PID: $BACKEND_PID)"
echo "[PYTHON] Log: $PROJECT_DIR/backend.log"
disown "$BACKEND_PID" 2>/dev/null || true

cd "$PROJECT_DIR"
log_step_end "Starting Python backend"

# ─── Wait for Python backend ────────────────────────────────────────────────
log_step_start "Waiting for Python backend"
wait_for_service "localhost" "3003" "Python backend" 30
log_step_end "Waiting for Python backend"

# ─── Health check on backend ────────────────────────────────────────────────
log_step_start "Backend health check"
HEALTH=$(curl -s --connect-timeout 5 "http://localhost:3003/api/health" 2>/dev/null || echo "failed")
if [ "$HEALTH" = "failed" ]; then
	echo "WARNING: Backend health check failed, but continuing..."
else
	echo "[PYTHON] Health: $HEALTH"
fi
log_step_end "Backend health check"

# ─── Start Next.js dev server ───────────────────────────────────────────────
log_step_start "Starting Next.js dev server"
echo "[BUN] Starting development server..."
bun run dev &
DEV_PID=$!
log_step_end "Starting Next.js dev server"

# ─── Wait for Next.js ───────────────────────────────────────────────────────
log_step_start "Waiting for Next.js dev server"
wait_for_service "localhost" "3000" "Next.js dev server" 60
log_step_end "Waiting for Next.js dev server"

# ─── Health check ───────────────────────────────────────────────────────────
log_step_start "Health check"
echo "[BUN] Performing health check..."
curl -fsS localhost:3000 >/dev/null
echo "[BUN] Health check passed"
log_step_end "Health check"

echo ""
echo "=========================================="
echo "  All services started successfully!"
echo "=========================================="
echo ""
echo "  Frontend (Next.js): http://localhost:3000"
echo "  Backend (Python):   http://localhost:3003"
echo ""
echo "  Press Ctrl+C to stop all services"
echo "=========================================="
echo ""

# Keep script running
wait
