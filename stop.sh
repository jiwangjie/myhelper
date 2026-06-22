#!/bin/bash
#
# stop.sh — 停止所有通过 run.sh 启动的服务
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.run-logs/pids.txt"

if [ ! -f "$PID_FILE" ]; then
	echo "未找到 PID 文件: $PID_FILE"
	echo "服务可能未通过 run.sh 启动，或已停止。"
	echo ""
	echo "如需手动停止，请执行："
	echo "  pkill -f 'uvicorn app.main'"
	echo "  pkill -f 'next dev'"
	echo "  pkill -f 'caddy run --config Caddyfile'"
	exit 0
fi

echo "🛑 正在停止所有服务..."

while IFS=: read -r name pid; do
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		echo "  停止 $name (PID: $pid)..."
		kill "$pid" 2>/dev/null || true
	fi
done < "$PID_FILE"

# 等待进程退出
sleep 2

# 检查是否还有残留
while IFS=: read -r name pid; do
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		echo "  强制停止 $name (PID: $pid)..."
		kill -9 "$pid" 2>/dev/null || true
	fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "✅ 所有服务已停止"
