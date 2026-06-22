#!/bin/bash
#
# ai-pipeline-python 部署脚本
# 用途：安装依赖、检查环境、启动 Python 后端服务
#
# 用法：
#   bash python-deploy.sh                # 默认部署（安装依赖 + 启动）
#   bash python-deploy.sh --skip-install # 跳过依赖安装
#   bash python-deploy.sh --check-only   # 仅检查环境，不启动服务
#   PORT=8080 bash python-deploy.sh     # 自定义端口（默认 3003）
#

set -euo pipefail

# ─── 配置 ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_DIR="$PROJECT_DIR/mini-services/ai-pipeline-python"
VENV_DIR="$PYTHON_DIR/.venv"
PORT="${PORT:-3003}"
HOST="${HOST:-0.0.0.0}"
SKIP_INSTALL=false
CHECK_ONLY=false

# ─── 参数解析 ────────────────────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --skip-install) SKIP_INSTALL=true ;;
        --check-only)   CHECK_ONLY=true ;;
        --help|-h)
            echo "Usage: bash python-deploy.sh [--skip-install] [--check-only] [PORT=3003] [HOST=0.0.0.0]"
            exit 0
            ;;
    esac
done

# ─── 颜色输出 ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── 步骤 ────────────────────────────────────────────────────────────────────

step_check_prerequisites() {
    log_info "检查前置条件..."

    # Python 3.8+
    if ! command -v python3 >/dev/null 2>&1; then
        log_error "未找到 python3，请先安装 Python 3.8+"
        exit 1
    fi
    PY_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2)
    log_ok "Python $PY_VERSION"

    # pip / venv
    if ! python3 -c "import venv" 2>/dev/null; then
        log_error "Python venv 模块不可用"
        exit 1
    fi
    log_ok "venv 可用"

    # curl (健康检查用)
    if ! command -v curl >/dev/null 2>&1; then
        log_warn "curl 不可用，跳过启动后健康检查"
    fi
}

step_setup_venv() {
    log_info "创建/激活虚拟环境..."

    if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
        log_ok "已激活现有虚拟环境: $VENV_DIR"
        return
    fi

    if python3 -m venv "$VENV_DIR" 2>/dev/null; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
        log_ok "虚拟环境已创建并激活: $VENV_DIR"
    else
        log_warn "无法创建虚拟环境 (缺少 python3-venv)"
        log_warn "将使用系统 Python 直接运行"
        # 确保 pip 可用
        if ! python3 -m ensurepip 2>/dev/null; then
            log_warn "ensurepip 也不可用，pip 可能未安装"
        else
            log_ok "pip 可用"
        fi
    fi
}

step_install_dependencies() {
    if "$SKIP_INSTALL"; then
        log_info "跳过依赖安装 (--skip-install)"
        return
    fi

    log_info "安装 Python 依赖..."

    cd "$PYTHON_DIR"

    # 确定 pip 命令（venv 内用 pip，系统级用 python3 -m pip）
    PIP_CMD="pip"
    if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/pip" ]; then
        PIP_CMD="$VENV_DIR/bin/pip"
    else
        PIP_CMD="python3 -m pip"
    fi

    # 升级 pip
    $PIP_CMD install --upgrade pip --quiet 2>/dev/null || true

    # 安装核心依赖
    if ! $PIP_CMD install -r requirements.txt --quiet; then
        log_warn "部分依赖安装失败，尝试逐个安装..."
        while IFS= read -r line; do
            # 跳过注释和空行
            [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
            $PIP_CMD install "$line" --quiet 2>/dev/null || log_warn "安装失败: $line"
        done < requirements.txt
    fi

    log_ok "依赖安装完成"

    # 检查可选的本地模型运行时
    log_info "检查可选本地模型运行时..."
    python3 -c "
import sys
optional = {
    'torch': '本地 LLM/TTS/图像 (CPU)',
    'transformers': '本地 LLM/TASR/TTS (transformers)',
    'diffusers': '本地图像 (diffusers)',
}
for mod, desc in optional.items():
    try:
        __import__(mod)
        print(f'  ✅ {mod} — {desc}')
    except ImportError:
        print(f'  ⬜ {mod} — {desc} (未安装，本地模型不可用)')
" || true
}

step_create_directories() {
    log_info "创建必要目录..."

    # 模型目录
    mkdir -p "$PYTHON_DIR/models"

    # 确保 __init__.py 存在
    touch "$PYTHON_DIR/app/__init__.py"

    log_ok "目录就绪"
}

step_check_config() {
    log_info "检查配置..."

    cd "$PYTHON_DIR"

    python3 -c "
from app.config import (
    DEFAULT_CONFIGS, DEFAULT_TTS_SETTINGS, DEFAULT_VOICE_PER_PROVIDER,
    DEFAULT_VOICE_LOCAL, VOICE_LIST_LOCAL, VOICE_MODES_LOCAL,
    VOICE_MODES_PER_PROVIDER, ZAI_CONFIG, SUGGESTED_LOCAL_MODELS,
)

# 验证声音模式配置完整性
assert 'preset' in VOICE_MODES_LOCAL, 'VOICE_MODES_LOCAL 缺少 preset'
assert 'clone' in VOICE_MODES_LOCAL, 'VOICE_MODES_LOCAL 缺少 clone'
assert 'design' in VOICE_MODES_LOCAL, 'VOICE_MODES_LOCAL 缺少 design'

for provider in ('zai', 'edge', 'custom'):
    assert provider in VOICE_MODES_PER_PROVIDER, f'VOICE_MODES_PER_PROVIDER 缺少 {provider}'
    assert 'preset' in VOICE_MODES_PER_PROVIDER[provider], f'{provider} modes 缺少 preset'

# 验证 custom provider 支持 clone/design
assert 'clone' in VOICE_MODES_PER_PROVIDER['custom'], 'custom provider 应支持 clone'
assert 'design' in VOICE_MODES_PER_PROVIDER['custom'], 'custom provider 应支持 design'

# 验证本地模式有默认音色
assert DEFAULT_VOICE_LOCAL, 'DEFAULT_VOICE_LOCAL 不应为空'
assert len(VOICE_LIST_LOCAL) > 0, 'VOICE_LIST_LOCAL 不应为空'
assert VOICE_LIST_LOCAL[0]['value'] == DEFAULT_VOICE_LOCAL, 'VOICE_LIST_LOCAL[0] 应为默认音色'

# 验证 custom provider 在线模式有默认音色
assert DEFAULT_VOICE_PER_PROVIDER.get('custom'), 'custom provider 默认音色不应为空'

# 验证 TTS 设置包含 customApiUrl/customApiKey
assert 'customApiUrl' in DEFAULT_TTS_SETTINGS, 'DEFAULT_TTS_SETTINGS 缺少 customApiUrl'
assert 'customApiKey' in DEFAULT_TTS_SETTINGS, 'DEFAULT_TTS_SETTINGS 缺少 customApiKey'

print('  ✅ 声音模式配置验证通过')
print(f'     VOICE_MODES_LOCAL:       {VOICE_MODES_LOCAL}')
print(f'     custom modes (API):      {VOICE_MODES_PER_PROVIDER[\"custom\"]}')
print(f'     custom default voice:    {DEFAULT_VOICE_PER_PROVIDER[\"custom\"]}')
print(f'     local default voice:     {DEFAULT_VOICE_LOCAL}')
print(f'     local voices:            {VOICE_LIST_LOCAL}')
print(f'     customApiUrl/customApiKey: {DEFAULT_TTS_SETTINGS[\"customApiUrl\"]}/{DEFAULT_TTS_SETTINGS[\"customApiKey\"]}')
" 2>&1

    log_ok "配置验证通过"
}

step_verify_imports() {
    log_info "验证应用模块导入..."

    cd "$PYTHON_DIR"

    if [ -f "$VENV_DIR/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
    fi

    python3 -c "
from app.main import app, socket_app
from app.config import (
    DEFAULT_CONFIGS, DEFAULT_TTS_SETTINGS, DEFAULT_VOICE_PER_PROVIDER,
    DEFAULT_VOICE_LOCAL, VOICE_LIST_LOCAL, VOICE_MODES_LOCAL,
    VOICE_MODES_PER_PROVIDER, ZAI_CONFIG, ZAI_VOICE_PRESETS,
    EDGE_VOICE_PRESETS, SUGGESTED_LOCAL_MODELS,
)
from app.schemas import ClientSettings, VoiceListResponse
from app.providers import tts_provider, llm_provider, asr_provider, image_provider

# 验证 ClientSettings 支持新字段
s = ClientSettings(
    ttsApiProvider='custom',
    customApiUrl='https://api.example.com',
    customApiKey='test-key',
    voiceMode='clone',
    cloneRefAudio='base64data',
    voiceDesignPrompt='a gentle voice',
)
assert s.customApiUrl == 'https://api.example.com'
assert s.customApiKey == 'test-key'
assert s.voiceMode == 'clone'

# 验证 VoiceListResponse 结构
vr = VoiceListResponse(
    provider='zai',
    defaultVoice='tongtong',
    voices=[{'value': 'tongtong', 'label': '童童'}],
    modes=['preset', 'clone', 'design'],
)
assert vr.modes == ['preset', 'clone', 'design']

print('  ✅ 所有模块导入成功')
print('  ✅ ClientSettings 支持 customApiUrl/customApiKey')
print('  ✅ VoiceListResponse 结构正确')
" 2>&1

    log_ok "模块导入验证通过"
}

step_health_check() {
    log_info "启动前健康检查..."

    cd "$PYTHON_DIR"

    if [ -f "$VENV_DIR/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
    fi

    # 检查端口是否被占用
    if command -v lsof >/dev/null 2>&1; then
        if lsof -i:"$PORT" -t >/dev/null 2>&1; then
            log_warn "端口 $PORT 已被占用"
        fi
    fi

    log_ok "端口 $PORT 可用"
}

step_start_server() {
    log_info "启动服务器..."

    cd "$PYTHON_DIR"

    if [ -f "$VENV_DIR/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
    fi

    export PORT="$PORT"
    export HOST="$HOST"

    echo ""
    echo "=========================================="
    echo "  ai-pipeline-python"
    echo "  http://$HOST:$PORT"
    echo "  Health: http://$HOST:$PORT/api/health"
    echo "=========================================="
    echo ""

    # 前台运行（适合 Docker / systemd / supervisor）
    exec python3 -m uvicorn app.main:socket_app \
        --host "$HOST" \
        --port "$PORT" \
        --log-level info
}

# ─── 主流程 ──────────────────────────────────────────────────────────────────

main() {
    echo ""
    echo "=========================================="
    echo "  ai-pipeline-python 部署脚本"
    echo "=========================================="
    echo ""

    step_check_prerequisites
    step_setup_venv
    step_install_dependencies
    step_create_directories

    if "$CHECK_ONLY"; then
        step_check_config
        step_verify_imports
        step_health_check
        log_info "环境检查完成 (--check-only 模式，不启动服务)"
        exit 0
    fi

    step_check_config
    step_verify_imports
    step_health_check
    step_start_server
}

main
