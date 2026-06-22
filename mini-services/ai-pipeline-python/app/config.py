"""Application configuration: ZAI API defaults, paths, constants.

Reads `/etc/.z-ai-config` (sandbox-provided) so the backend works out-of-box.
Users can still override per-service via the frontend Settings dialog.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent  # mini-services/ai-pipeline-python
PROJECT_ROOT = BASE_DIR.parent.parent              # project root
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# HuggingFace cache directory (where models--<org>--<name>/ directories live).
# Resolution priority (matches huggingface_hub's own logic):
#   1. $HF_HUB_CACHE  (most specific, hub cache only)
#   2. $HF_HOME/hub   (HF_HOME is the root of the whole cache tree)
#   3. ~/.cache/huggingface/hub  (platform default)
_HF_HOME = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
HF_CACHE_DIR = Path(os.environ.get("HF_HUB_CACHE") or os.path.join(_HF_HOME, "hub"))

# ─── Constants ────────────────────────────────────────────────────────────────
PORT = 3003
MAX_HISTORY = 20
SAMPLE_RATE = 24000        # ZAI TTS PCM sample rate
TTS_MAX_CHARS = 1024       # ZAI TTS single-call limit (skill doc: 1024)

DEFAULT_SYSTEM_PROMPT = (
    "你是一个拥有人类躯体的AI助手，名叫\"小智\"。你可以正常与用户语音对话。\n\n"
    "【重要规则】\n"
    "1. 每次回复【必须】包含一个 <action>动作描述</action> 标签，用于驱动你的立绘生成。\n"
    "2. 每次回复【最多只能包含一个】动作标签，不得出现多个。\n"
    "3. 动作描述要简洁具体，描述你的表情、姿态或动作，例如：<action>开心地挥手打招呼</action>。\n"
    "4. <action> 标签应自然融入回复，不要在标签外说多余的话。\n"
    "5. 保持自然对话节奏，先用文字回应，再附带动作标签，或交错使用。\n\n"
    "示例：\n"
    "- 你好呀！<action>微笑着向你点头致意</action> 今天有什么我可以帮你的吗？\n"
    "- 这个问题我来解答。<action>托着下巴认真思考</action> 根据我的理解……"
)

# ─── ZAI API config (loaded from /etc/.z-ai-config or env) ────────────────────
ZAI_CONFIG: dict[str, Any] = {}


def _load_zai_config() -> dict[str, Any]:
    """Load ZAI API credentials.

    Priority:
      1. env vars ZAI_API_BASE_URL + ZAI_API_KEY (+ optional ZAI_TOKEN)
      2. /etc/.z-ai-config (sandbox-provided file)
      3. ~/.z-ai-config or ./z-ai-config (user-provided)
    """
    env_url = os.environ.get("ZAI_API_BASE_URL")
    env_key = os.environ.get("ZAI_API_KEY")
    if env_url and env_key:
        return {
            "baseUrl": env_url,
            "apiKey": env_key,
            "token": os.environ.get("ZAI_TOKEN", ""),
            "chatId": os.environ.get("ZAI_CHAT_ID", ""),
            "userId": os.environ.get("ZAI_USER_ID", ""),
        }

    candidates = [
        "/etc/.z-ai-config",
        os.path.expanduser("~/.z-ai-config"),
        str(PROJECT_ROOT / ".z-ai-config"),
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if cfg.get("baseUrl") and cfg.get("apiKey"):
                return cfg
        except FileNotFoundError:
            continue
        except Exception:
            continue
    return {}


ZAI_CONFIG = _load_zai_config()

# Public default URL shown in the frontend text boxes. We expose the
# documented ZAI API URL (not the internal one) so users can plug in their
# own ZAI account API key.
DEFAULT_ZAI_API_URL = "https://api.z.ai/api/paas/v4"

# ─── Default per-service config (mirrors frontend chat-store defaults) ────────
DEFAULT_CONFIGS = {
    "llm": {
        "mode": "api",
        "enabled": True,
        "apiUrl": DEFAULT_ZAI_API_URL,
        "apiKey": "",
        "modelName": "glm-4.6",
        "modelPath": "",
        "systemPrompt": DEFAULT_SYSTEM_PROMPT,
        "apiParams": {"max_tokens": 2048, "temperature": 0.7, "top_p": 0.9},
        "extraParams": {},
    },
    "asr": {
        "mode": "api",
        "enabled": True,
        "apiUrl": DEFAULT_ZAI_API_URL,
        "apiKey": "",
        "modelName": "auto",
        "modelPath": "",
        "systemPrompt": "",
        "apiParams": {},
        "extraParams": {},
    },
    "tts": {
        "mode": "api",
        "enabled": True,
        "apiUrl": DEFAULT_ZAI_API_URL,
        "apiKey": "",
        "modelName": "tongtong",
        "modelPath": "",
        "systemPrompt": "",
        "apiParams": {},
        "extraParams": {},
    },
    "image": {
        "mode": "api",
        "enabled": True,
        "apiUrl": DEFAULT_ZAI_API_URL,
        "apiKey": "",
        "modelName": "cogview-3-plus",
        "modelPath": "",
        "systemPrompt": "",
        "apiParams": {},
        "extraParams": {"size": "1024x1024"},
    },
}

# ─── TTS voice presets per provider ───────────────────────────────────────────
# These are loaded by the frontend via GET /api/tts/voices?provider=...
ZAI_VOICE_PRESETS = [
    {"value": "tongtong", "label": "童童 - 温暖亲切"},
    {"value": "chuichui", "label": "吹吹 - 活泼可爱"},
    {"value": "xiaochen", "label": "小晨 - 沉稳专业"},
    {"value": "jam", "label": "Jam - 英音绅士"},
    {"value": "kazi", "label": "Kazi - 清晰标准"},
    {"value": "douji", "label": "豆吉 - 自然流畅"},
    {"value": "luodo", "label": "罗多 - 富有感染力"},
]

EDGE_VOICE_PRESETS = [
    {"value": "zh-CN-XiaoxiaoNeural", "label": "晓晓 - 温暖女声（默认）"},
    {"value": "zh-CN-XiaoyiNeural", "label": "晓依 - 活泼女声"},
    {"value": "zh-CN-YunjianNeural", "label": "云健 - 沉稳男声"},
    {"value": "zh-CN-YunxiNeural", "label": "云希 - 阳光男声"},
    {"value": "zh-CN-YunxiaNeural", "label": "云夏 - 少年男声"},
    {"value": "zh-CN-YunyangNeural", "label": "云扬 - 新闻男声"},
    {"value": "zh-CN-XiaochenNeural", "label": "小辰 - 柔和女声"},
    {"value": "zh-CN-XiaohanNeural", "label": "晓涵 - 甜美女声"},
    {"value": "zh-CN-XiaomengNeural", "label": "晓梦 - 童声女声"},
    {"value": "zh-CN-XiaomoNeural", "label": "晓墨 - 知性女声"},
    {"value": "zh-CN-XiaoruiNeural", "label": "晓睿 - 长者女声"},
    {"value": "zh-CN-XiaoshuangNeural", "label": "晓双 - 童声女声"},
    {"value": "zh-CN-XiaoxuanNeural", "label": "晓萱 - 温柔女声"},
    {"value": "zh-CN-XiaoyanNeural", "label": "晓颜 - 亲切女声"},
    {"value": "zh-CN-XiaozhenNeural", "label": "晓甄 - 优雅女声"},
    {"value": "en-US-JennyNeural", "label": "Jenny - 英语女声"},
    {"value": "en-US-GuyNeural", "label": "Guy - 英语男声"},
    {"value": "ja-JP-NanamiNeural", "label": "Nanami - 日语女声"},
    {"value": "ko-KR-SunHiNeural", "label": "SunHi - 韩语女声"},
]

# Default voice per provider (used when user switches provider without picking)
DEFAULT_VOICE_PER_PROVIDER = {
    "zai": "tongtong",
    "edge": "zh-CN-XiaoxiaoNeural",
    "custom": "default",
}

# Default voice for local TTS mode (CosyVoice / ChatTTS / VITS etc.)
DEFAULT_VOICE_LOCAL = "default"

# Voice modes supported per provider (online API mode)
VOICE_MODES_PER_PROVIDER = {
    "zai": ["preset", "clone", "design"],
    "edge": ["preset"],
    "custom": ["preset", "clone", "design"],
}

# Voice modes supported in local-model mode.
# Local TTS frameworks (CosyVoice, ChatTTS, VITS, etc.) can support clone/design
# via their own mechanisms (reference audio, speaker embeddings, instruct text).
# We expose all three modes so the UI allows the user to select them.
VOICE_MODES_LOCAL = ["preset", "clone", "design"]

# Voice list for local-model mode.
# Local models expose a "default" preset voice; clone/design are handled via
# reference audio / design prompt rather than a fixed voice list.
VOICE_LIST_LOCAL = [
    {"value": "default", "label": "默认音色（模型内置）"},
]

# Default TTS top-level settings
DEFAULT_TTS_SETTINGS = {
    "ttsApiProvider": "edge",
    "ttsVoice": "zh-CN-XiaoxiaoNeural",
    "ttsSpeed": 1.0,
    "ttsVolume": 1.0,
    "voiceMode": "preset",
    "cloneRefAudio": "",
    "voiceDesignPrompt": "",
    "customApiUrl": "",
    "customApiKey": "",
}

DEFAULT_IMAGE_SETTINGS = {
    "imageSize": "1024x1024",
    "imageUseReference": False,
    "imageReferenceImage": "",
}

# Known local model suggestions (shown in the "download by name" UI).
# These are HuggingFace repo IDs that users can type to download.
# The actual model list is dynamically scanned from the HF cache directory.
SUGGESTED_LOCAL_MODELS = {
    "llm": [
        "unsloth/gemma-4-E4B-it-GGUF",
        "Qwen/Qwen2.5-7B-Instruct",
        "Qwen/Qwen2.5-14B-Instruct",
        "meta-llama/Llama-3.1-8B-Instruct",
    ],
    "asr": [
        "openai/whisper-large-v3",
        "openai/whisper-medium",
        "FunAudioLLM/SenseVoiceSmall",
    ],
    "tts": [
        "k2-fsa/OmniVoice",
        "FunAudioLLM/CosyVoice2-0.5B",
        "FunAudioLLM/CosyVoice3-0.5B",
        "2Noise/ChatTTS",
    ],
    "image": [
        "stable-diffusion-v1-5/stable-diffusion-v1-5",
        "stabilityai/stable-diffusion-xl-base-1.0",
        "black-forest-labs/FLUX.1-schnell",
    ],
}
