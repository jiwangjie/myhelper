"""LLM provider: online (ZAI API) + local (transformers).

Public API:
  async generate_completion(messages, settings) -> str
  async translate_action_to_prompt(action, settings) -> str   (for image gen)
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

import httpx

from ..config import DEFAULT_SYSTEM_PROMPT, ZAI_CONFIG
from ..schemas import ClientSettings, ModelConfig
from .base import (http_post_json, is_rate_limited, is_zai_configured,
                   make_zai_headers, zai_base_url)

# LRU-ish cache for local models: {model_path: (model, tokenizer)}
_LOCAL_LLM_CACHE: dict[str, Any] = {}

ACTION_TRANSLATE_SYS_PROMPT = (
    "You are an image prompt engineer. Translate the user's Chinese action/emotion "
    "description into a concise English visual prompt for an anime-style character "
    "portrait. Output ONLY the prompt, no explanation. Example: '开心地挥手' -> "
    "'a cheerful anime girl waving happily, upper body, soft lighting, smile'. "
    "Keep it under 40 words."
)

FALLBACK_MAP = {
    "挥手": "waving hand",
    "笑": "smiling",
    "开心": "happy smile",
    "生气": "angry expression",
    "思考": "thinking pose",
    "点头": "nodding",
    "惊讶": "surprised expression",
    "难过": "sad expression",
}


# ─── Online (ZAI API) ─────────────────────────────────────────────────────────

async def _zai_chat(messages: list[dict[str, str]],
                    llm_cfg: Optional[ModelConfig]) -> str:
    """Call ZAI chat.completions endpoint, return assistant text."""
    if not is_zai_configured():
        raise RuntimeError("ZAI API 未配置（缺少 /etc/.z-ai-config 或 ZAI_API_BASE_URL/ZAI_API_KEY 环境变量）")

    base = zai_base_url()
    url = f"{base}/chat/completions"

    body: dict[str, Any] = {
        "messages": messages,
        "thinking": {"type": "disabled"},
    }
    # Include model name if user selected one
    if llm_cfg and llm_cfg.modelName:
        body["model"] = llm_cfg.modelName
    if llm_cfg and llm_cfg.apiParams:
        ap = llm_cfg.apiParams
        if ap.get("max_tokens") is not None:
            body["max_tokens"] = int(ap["max_tokens"])
        if ap.get("temperature") is not None:
            body["temperature"] = float(ap["temperature"])
        if ap.get("top_p") is not None:
            body["top_p"] = float(ap["top_p"])

    # Retry on 429
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            r = await http_post_json(url, make_zai_headers(), body, timeout=60.0)
            if r.status_code == 429:
                raise httpx_429_error()
            r.raise_for_status()
            data = r.json()
            return (data.get("choices", [{}])[0].get("message", {}).get("content")
                    or "")
        except Exception as e:
            last_err = e
            if is_rate_limited(e) and attempt < 2:
                await asyncio.sleep(1.0 * (2 ** attempt))
                continue
            raise
    raise last_err or RuntimeError("LLM 请求失败")


def httpx_429_error() -> Exception:
    return httpx.HTTPStatusError(
        "429 Too Many Requests", request=None, response=httpx.Response(429)  # type: ignore
    )


# ─── Local (transformers) ────────────────────────────────────────────────────

# Per-model locks to prevent concurrent loading (which would double RAM).
_LLM_LOAD_LOCKS: dict[str, asyncio.Lock] = {}


def _load_local_llm_sync(model_path: str):
    """Load a local LLM via transformers (sync, to be called in a thread)."""
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as e:
        raise RuntimeError(
            "本地 LLM 运行时未安装。请运行: pip install torch transformers"
        ) from e

    tok = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=torch.float32,
        device_map="cpu",
        trust_remote_code=True,
    )
    model.eval()
    return model, tok


async def _load_local_llm(model_path: str):
    """Load a local LLM via transformers (cached in process, with per-model lock)."""
    if model_path in _LOCAL_LLM_CACHE:
        return _LOCAL_LLM_CACHE[model_path]

    # Per-model lock prevents concurrent loading (which would double RAM).
    lock = _LLM_LOAD_LOCKS.get(model_path)
    if lock is None:
        lock = asyncio.Lock()
        _LLM_LOAD_LOCKS[model_path] = lock

    async with lock:
        # Double-check after acquiring lock (another coroutine may have loaded it).
        if model_path in _LOCAL_LLM_CACHE:
            return _LOCAL_LLM_CACHE[model_path]
        result = await asyncio.to_thread(_load_local_llm_sync, model_path)
        _LOCAL_LLM_CACHE[model_path] = result
        return result


async def _local_chat(messages: list[dict[str, str]],
                      llm_cfg: ModelConfig) -> str:
    """Run a local LLM chat completion (CPU, blocking -> thread)."""
    if not llm_cfg.modelPath:
        raise RuntimeError("本地 LLM 未指定模型路径")
    model, tok = await _load_local_llm(llm_cfg.modelPath)

    import torch

    # Build prompt: ZAI uses 'assistant' role for system prompt; transformers
    # chat templates expect 'system'. Map accordingly.
    chat_messages = []
    for m in messages:
        role = m["role"]
        if role == "assistant" and chat_messages and chat_messages[0]["role"] != "system":
            # Treat leading 'assistant' (system-prompt slot) as system
            chat_messages.append({"role": "system", "content": m["content"]})
        else:
            chat_messages.append({"role": role, "content": m["content"]})

    def _generate():
        # apply chat template if available
        if hasattr(tok, "apply_chat_template") and tok.chat_template:
            input_ids = tok.apply_chat_template(
                chat_messages, add_generation_prompt=True,
                return_tensors="pt"
            ).to(model.device)
        else:
            # Fallback: concat messages
            text = "\n".join(f"{m['role']}: {m['content']}" for m in chat_messages)
            text += "\nassistant: "
            input_ids = tok(text, return_tensors="pt").input_ids.to(model.device)

        with torch.no_grad():
            out = model.generate(
                input_ids,
                max_new_tokens=int(llm_cfg.apiParams.get("max_tokens", 1024)),
                do_sample=True,
                temperature=float(llm_cfg.apiParams.get("temperature", 0.7)),
                top_p=float(llm_cfg.apiParams.get("top_p", 0.9)),
                pad_token_id=tok.eos_token_id or tok.pad_token_id,
            )
        new_tokens = out[0][input_ids.shape[-1]:]
        return tok.decode(new_tokens, skip_special_tokens=True).strip()

    return await asyncio.to_thread(_generate)


# ─── Local (GGUF / llama.cpp) ─────────────────────────────────────────────────

# Cache for GGUF models: {model_path: Llama instance}
_LOCAL_GGUF_CACHE: dict[str, Any] = {}


def _is_gguf_model(model_path: str) -> bool:
    """Check if a model path points to a GGUF file."""
    return model_path.lower().endswith(".gguf")


def _load_gguf_model_sync(model_path: str):
    """Load a GGUF model via llama.cpp (sync, to be called in a thread)."""
    try:
        from llama_cpp import Llama
    except ImportError as e:
        raise RuntimeError(
            "GGUF 模型需要 llama-cpp-python。请运行: pip install llama-cpp-python"
        ) from e

    llm = Llama(
        model_path=model_path,
        n_ctx=4096,                          # context window
        n_threads=4,                         # CPU threads
        n_gpu_layers=0,                      # CPU only
        verbose=False,
    )
    return llm


async def _load_gguf_model(model_path: str):
    """Load a GGUF model (cached in process)."""
    if model_path in _LOCAL_GGUF_CACHE:
        return _LOCAL_GGUF_CACHE[model_path]

    # Resolve repo_id to actual path if needed
    actual_path = _resolve_model_path(model_path)
    result = await asyncio.to_thread(_load_gguf_model_sync, actual_path)
    _LOCAL_GGUF_CACHE[model_path] = result
    return result


def _resolve_model_path(model_path: str) -> str:
    """Resolve a model path to an actual local path.

    Handles:
    - Direct file paths (e.g., /path/to/model.gguf)
    - HF repo IDs (e.g., unsloth/gemma-4-E4B-it-GGUF)
    - Snapshot paths (e.g., ~/.cache/huggingface/hub/models--.../snapshots/<hash>/)
    """
    import os
    from pathlib import Path
    # If it's already a file path, return as-is
    if os.path.isfile(model_path):
        return model_path
    # If it's a directory, look for a .gguf file inside
    if os.path.isdir(model_path):
        gguf = [f for f in os.listdir(model_path) if f.endswith(".gguf")]
        if gguf:
            return os.path.join(model_path, gguf[0])
    # If it looks like a repo_id (org/name), try to find in HF cache
    if "/" in model_path and not model_path.startswith("/"):
        from ..config import HF_CACHE_DIR
        cache_dir = Path(HF_CACHE_DIR)
        # Try models--<org>--<name> pattern
        parts = model_path.split("/", 1)
        if len(parts) == 2:
            prefix = parts[0].replace("-", "--")  # normalize
            pattern = f"models--{prefix}--{parts[1]}"
            for entry in cache_dir.iterdir():
                if entry.name.startswith(pattern):
                    snap_dir = entry / "snapshots"
                    if snap_dir.exists():
                        for snap in snap_dir.iterdir():
                            if snap.is_dir():
                                # Look for GGUF or model files
                                files = list(snap.iterdir())
                                gguf = [f for f in files if f.name.endswith(".gguf")]
                                if gguf:
                                    return str(gguf[0])
                                # Return directory if it has model files
                                if any(f.is_file() for f in files):
                                    return str(snap)
    return model_path


def _apply_chat_template_to_messages(messages: list[dict[str, str]]) -> str:
    """Convert messages to a simple chat prompt string.

    GGUF models loaded via llama-cpp-python don't have a tokenizer chat
    template, so we build the prompt manually.

    Uses Gemma 3 format: <start_of_turn>user\\n...<end_of_turn>\\n<start_of_turn>model\\n
    """
    parts = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            # Gemma doesn't have a separate system role; prepend to first user message
            parts.append(f"<start_of_turn>user\n{content}\n<end_of_turn>\n")
        elif role == "user":
            parts.append(f"<start_of_turn>user\n{content}\n<end_of_turn>\n")
        elif role == "assistant":
            parts.append(f"<start_of_turn>model\n{content}\n<end_of_turn>\n")
        else:
            parts.append(f"<start_of_turn>model\n{content}\n<end_of_turn>\n")
    # Add generation prompt for the model to continue
    parts.append("<start_of_turn>model\n")
    return "".join(parts)


async def _local_gguf_chat(messages: list[dict[str, str]],
                           llm_cfg: ModelConfig) -> str:
    """Run a GGUF model chat completion via llama.cpp."""
    if not llm_cfg.modelPath:
        raise RuntimeError("本地 LLM 未指定模型路径")

    model_path = llm_cfg.modelPath

    # Find the actual GGUF file path
    import os
    if os.path.isdir(model_path):
        # If model_path is a directory, look for a .gguf file inside
        gguf_files = [f for f in os.listdir(model_path) if f.endswith(".gguf")]
        if not gguf_files:
            raise RuntimeError(f"GGUF 模型目录中未找到 .gguf 文件: {model_path}")
        model_path = os.path.join(model_path, gguf_files[0])
    elif not os.path.isfile(model_path):
        raise RuntimeError(f"GGUF 模型文件不存在: {model_path}")

    llm = await _load_gguf_model(model_path)

    prompt = _apply_chat_template_to_messages(messages)

    def _generate():
        output = llm(
            prompt,
            max_tokens=int(llm_cfg.apiParams.get("max_tokens", 1024)),
            temperature=float(llm_cfg.apiParams.get("temperature", 0.7)),
            top_p=float(llm_cfg.apiParams.get("top_p", 0.9)),
            stop=["</s>", "[INST]", "\n\n\n"],
            echo=False,
        )
        return (output.get("choices", [{}])[0].get("text", "") or "").strip()

    return await asyncio.to_thread(_generate)


# ─── Public API ───────────────────────────────────────────────────────────────

def _is_local_gguf_mode(llm_cfg: Optional[ModelConfig]) -> bool:
    """Check if the user selected a local GGUF model."""
    if not llm_cfg or llm_cfg.mode != "local":
        return False
    model_path = llm_cfg.modelPath or ""
    # Check if path ends with .gguf or contains a .gguf file
    if model_path.lower().endswith(".gguf"):
        return True
    import os
    if os.path.isdir(model_path):
        return any(f.endswith(".gguf") for f in os.listdir(model_path))
    return False


async def generate_completion(messages: list[dict[str, str]],
                              settings: Optional[ClientSettings]) -> str:
    """Generate an LLM completion. Routes to online, local GGUF, or local transformers."""
    llm_cfg = settings.llm if settings and settings.llm else None
    mode = llm_cfg.mode if llm_cfg else "api"

    if mode == "local":
        # Detect GGUF vs PyTorch model
        if _is_local_gguf_mode(llm_cfg):
            try:
                return await _local_gguf_chat(messages, llm_cfg)  # type: ignore
            except Exception as e:
                # Fall back to online if local fails
                print(f"[LLM] Local GGUF failed, falling back to ZAI API: {e}")
                return await _zai_chat(messages, llm_cfg)
        else:
            try:
                return await _local_chat(messages, llm_cfg)  # type: ignore
            except Exception as e:
                # Fall back to online if local fails
                print(f"[LLM] Local transformers failed, falling back to ZAI API: {e}")
                return await _zai_chat(messages, llm_cfg)
    return await _zai_chat(messages, llm_cfg)


async def translate_action_to_prompt(action: str,
                                     settings: Optional[ClientSettings]) -> str:
    """Translate a Chinese <action> tag to an English image prompt.

    Tries LLM first (with 429 retry), falls back to keyword mapping.
    """
    if not action:
        return "a friendly anime girl, upper body portrait, soft lighting"

    llm_cfg = settings.llm if settings else None
    mode = llm_cfg.mode if llm_cfg else "api"

    try:
        if mode == "local" and llm_cfg and llm_cfg.modelPath:
            messages = [
                {"role": "system", "content": ACTION_TRANSLATE_SYS_PROMPT},
                {"role": "user", "content": action},
            ]
            if _is_local_gguf_mode(llm_cfg):
                prompt = await _local_gguf_chat(messages, llm_cfg)
            else:
                prompt = await _local_chat(messages, llm_cfg)
        else:
            messages = [
                {"role": "system", "content": ACTION_TRANSLATE_SYS_PROMPT},
                {"role": "user", "content": action},
            ]
            # Short retry loop for 429
            prompt = ""
            for attempt in range(2):
                try:
                    prompt = await _zai_chat(messages, llm_cfg)
                    if prompt:
                        break
                except Exception as e:
                    if is_rate_limited(e) and attempt == 0:
                        await asyncio.sleep(2.0)
                        continue
                    raise
        if prompt:
            return prompt.strip()
    except Exception as e:
        print(f"[Action] LLM translate failed: {e}")

    # Fallback: keyword mapping
    for zh, en in FALLBACK_MAP.items():
        if zh in action:
            return f"a cute anime girl, {en}, upper body portrait, soft studio lighting, high quality"
    return "a cute anime girl, friendly expression, upper body portrait, soft studio lighting, high quality"
