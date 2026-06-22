#!/bin/bash
#
# run.sh — 一键启动 AI智聊全栈服务
#
# 启动顺序：
#   1. Python 后端 (FastAPI + Socket.IO, port 3003)
#   2. Next.js 前端 (dev mode, port 3000)
#   3. Caddy 反向代理 (port 8080, 自动路由到前端/后端)
#
# 使用方法：
#   chmod +x run.sh && ./run.sh
#
# 按 Ctrl+C 停止所有服务。
#

set -euo pipefail

# ─── 配置 ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/.run-logs"
mkdir -p "$LOG_DIR"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
CADDY_LOG="$LOG_DIR/caddy.log"
PID_FILE="$LOG_DIR/pids.txt"

# ─── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── 清理函数 ────────────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""
CADDY_PID=""

cleanup() {
	echo ""
	log_info "正在停止所有服务..."

	if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
		log_info "停止 Python 后端 (PID: $BACKEND_PID)..."
		kill "$BACKEND_PID" 2>/dev/null || true
	fi

	if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
		log_info "停止 Next.js 前端 (PID: $FRONTEND_PID)..."
		kill "$FRONTEND_PID" 2>/dev/null || true
	fi

	if [ -n "$CADDY_PID" ] && kill -0 "$CADDY_PID" 2>/dev/null; then
		log_info "停止 Caddy (PID: $CADDY_PID)..."
		kill "$CADDY_PID" 2>/dev/null || true
	fi

	# 等待所有进程退出
	sleep 1
	for pid in $BACKEND_PID $FRONTEND_PID $CADDY_PID; do
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			log_warn "强制停止进程 $pid..."
			kill -9 "$pid" 2>/dev/null || true
		fi
	done

	# 清理 PID 文件
	rm -f "$PID_FILE"

	log_ok "所有服务已停止"
}

# 注意：不在这里设置 trap cleanup EXIT，因为脚本需要正常退出（服务独立运行）。
# trap 只处理 Ctrl+C (INT) 和 kill (TERM)，让用户可以手动停止服务。
trap cleanup INT TERM

# ─── 前置检查 ────────────────────────────────────────────────────────────────
log_info "检查依赖..."

if ! command -v bun >/dev/null 2>&1; then
	log_error "bun 未安装。请访问 https://bun.sh 安装。"
	exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
	log_error "python3 未安装。"
	exit 1
fi

if ! command -v caddy >/dev/null 2>&1; then
	log_error "Caddy 未安装。请访问 https://caddyserver.com/docs/install 安装。"
	exit 1
fi

# 检查 Python 依赖
if ! python3 -c "import uvicorn, socketio, fastapi, httpx, pydantic, edge_tts, numpy, soundfile" 2>/dev/null; then
	log_error "Python 依赖未安装。请运行："
	log_error "  cd mini-services/ai-pipeline-python"
	log_error "  pip install -r requirements.txt"
	exit 1
fi

log_ok "所有依赖就绪"

# ─── 创建 .env ───────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
	log_info "创建 .env 文件..."
	if [ -f ".env.example" ]; then
		cp .env.example .env
		sed -i "s|DATABASE_URL=file:.*|DATABASE_URL=file:$SCRIPT_DIR/db/custom.db|" .env
	else
		echo "DATABASE_URL=file:$SCRIPT_DIR/db/custom.db" > .env
	fi
	log_ok ".env 已创建"
fi

# ─── 创建数据库 ──────────────────────────────────────────────────────────────
mkdir -p db
if [ ! -f "db/custom.db" ]; then
	log_info "初始化数据库..."
	if [ -f "node_modules/.bin/prisma" ]; then
		DATABASE_URL="file:$SCRIPT_DIR/db/custom.db" node_modules/.bin/prisma db push --skip-generate 2>/dev/null || true
	fi
	log_ok "数据库就绪"
fi

# ─── 安装 Node 依赖 ──────────────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
	log_info "安装 Node.js 依赖..."
	bun install
	log_ok "Node.js 依赖已安装"
fi

# ─── 启动 Python 后端 ────────────────────────────────────────────────────────
log_info "启动 Python 后端 (port 3003)..."

BACKEND_DIR="$SCRIPT_DIR/mini-services/ai-pipeline-python"
cd "$BACKEND_DIR"

# 使用系统 python3（已安装所有依赖）
# 日志同时输出到终端和日志文件（tee），方便实时查看
python3 -m uvicorn app.main:socket_app \
	--host 0.0.0.0 \
	--port 3003 \
	--log-level info \
	2>&1 | tee "$BACKEND_LOG" &

BACKEND_PID=$!
echo "backend:$BACKEND_PID" >> "$PID_FILE"
cd "$SCRIPT_DIR"

# 等待后端启动
log_info "等待 Python 后端就绪..."
for i in $(seq 1 30); do
	if curl -s --connect-timeout 2 --max-time 3 "http://localhost:3003/api/health" >/dev/null 2>&1; then
		log_ok "Python 后端已启动 (PID: $BACKEND_PID)"
		break
	fi
	if [ "$i" -eq 30 ]; then
		log_error "Python 后端启动超时"
		log_error "日志: $BACKEND_LOG"
		tail -20 "$BACKEND_LOG"
		exit 1
	fi
	sleep 1
done

# ─── 启动 Next.js 前端 ───────────────────────────────────────────────────────
log_info "启动 Next.js 前端 (port 3000)..."

bun run dev 2>&1 | tee "$FRONTEND_LOG" &
FRONTEND_PID=$!
echo "frontend:$FRONTEND_PID" >> "$PID_FILE"

# 等待前端启动
log_info "等待 Next.js 前端就绪..."
for i in $(seq 1 60); do
	if curl -s --connect-timeout 2 --max-time 3 "http://localhost:3000" >/dev/null 2>&1; then
		log_ok "Next.js 前端已启动 (PID: $FRONTEND_PID)"
		break
	fi
	if [ "$i" -eq 60 ]; then
		log_error "Next.js 前端启动超时"
		log_error "日志: $FRONTEND_LOG"
		tail -20 "$FRONTEND_LOG"
		exit 1
	fi
	sleep 1
done

# ─── 启动 Caddy ───────────────────────────────────────────────────────────────
log_info "启动 Caddy 反向代理 (port 8080)..."

if [ ! -f "Caddyfile" ]; then
	log_error "Caddyfile 不存在！"
	exit 1
fi

# Caddy 使用 Caddyfile 中配置的 admin 端口 (127.0.0.1:2020)，
# 避免与系统 Caddy 的默认 admin 端口 (127.0.0.1:2019) 冲突
# 监听端口 8080（非 root 用户不能绑定 1024 以下端口，系统 Caddy 已占用 81）
log_info "Caddy 监听端口: 8080, admin: 127.0.0.1:2020"

caddy run --config Caddyfile --adapter caddyfile 2>&1 | tee "$CADDY_LOG" &
CADDY_PID=$!
echo "caddy:$CADDY_PID" >> "$PID_FILE"

# 等待 Caddy 启动
sleep 2
if kill -0 "$CADDY_PID" 2>/dev/null; then
	log_ok "Caddy 已启动 (PID: $CADDY_PID)"
else
	log_error "Caddy 启动失败"
	log_error "日志: $CADDY_LOG"
	tail -20 "$CADDY_LOG"
	exit 1
fi

# ─── 验证所有服务 ─────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
log_ok "所有服务启动成功！"
echo "=========================================="
echo ""
echo -e "  🌐 前端访问地址:  ${GREEN}http://localhost:8080${NC}"
echo -e "  ⚡ 后端 API 地址:  ${GREEN}http://localhost:3003${NC}"
echo -e "  📦 Caddy 代理地址: ${GREEN}http://localhost:8080${NC}"
echo ""
echo "  日志目录: $LOG_DIR"
echo "    - backend.log"
echo "    - frontend.log"
echo "    - caddy.log"
echo ""
echo "  停止服务: bash stop.sh"
echo "=========================================="
echo ""

# 保持脚本运行，实时输出日志到终端
# 用户按 Ctrl+C 停止所有服务
log_info "服务运行中... 按 Ctrl+C 停止所有服务"
trap cleanup INT TERM

# 等待所有后台进程
wait
