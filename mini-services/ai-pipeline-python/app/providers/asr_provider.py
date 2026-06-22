"""ASR provider: online (ZAI API) + local (transformers whisper pipeline).

Public API:
  async transcribe(audio_base64, format, settings) -> str
"""
from __future__ import annotations

import asyncio
import io
from typing import Any, Optional

import httpx

from ..schemas import ClientSettings, ModelConfig
from ..utils.audio import base64_to_bytes
from .base import (is_rate_limited, is_zai_configured, make_zai_headers,
                   zai_base_url)

# Model cache + per-key locks to prevent concurrent loading of the same model
# (which would double RAM usage and risk OOM).
_LOCAL_ASR_CACHE: dict[str, Any] = {}
_ASR_LOAD_LOCKS: dict[str, asyncio.Lock] = {}


# ─── Online (ZAI API) ─────────────────────────────────────────────────────────

async def _zai_asr(audio_bytes: bytes, settings: ClientSettings) -> str:
    """Call ZAI audio/asr endpoint, return transcribed text.

    The ZAI ASR API accepts a JSON body with `file_base64` (raw base64, no
    data: prefix). WAV/MP3/M4A/FLAC/OGG supported.
    """
    if not is_zai_configured():
        raise RuntimeError("ZAI API 未配置")

    url = f"{zai_base_url()}/audio/asr"
    import base64
    body = {"file_base64": base64.b64encode(audio_bytes).decode("ascii")}

    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(url, headers=make_zai_headers(), json=body)
                if r.status_code == 429:
                    raise httpx.HTTPStatusError(
                        "429 Too Many Requests",
                        request=r.request, response=r,
                    )
                r.raise_for_status()
                data = r.json()
                return data.get("text", "") or ""
        except Exception as e:
            last_err = e
            if is_rate_limited(e) and attempt < 2:
                await asyncio.sleep(1.0 * (2 ** attempt))
                continue
            raise
    raise last_err or RuntimeError("ASR 请求失败")


# ─── Local (transformers whisper pipeline) ────────────────────────────────────

async def _local_asr(audio_bytes: bytes, settings: ClientSettings,
                     asr_cfg: ModelConfig) -> str:
    """Run a local ASR model via transformers pipeline.

    Supports whisper and SenseVoice-style models that are pipeline-compatible.
    """
    if not asr_cfg.modelPath:
        raise RuntimeError("本地 ASR 未指定模型路径")

    model_path = asr_cfg.modelPath

    # Use a per-model lock so concurrent requests for the same model
    # don't load it twice (which would double RAM usage).
    lock = _ASR_LOAD_LOCKS.get(model_path)
    if lock is None:
        lock = asyncio.Lock()
        _ASR_LOAD_LOCKS[model_path] = lock

    async with lock:
        if model_path not in _LOCAL_ASR_CACHE:
            def _load():
                try:
                    import torch  # noqa: F401
                    from transformers import pipeline
                except ImportError as e:
                    raise RuntimeError(
                        "本地 ASR 运行时未安装。请运行: pip install torch transformers"
                    ) from e
                # chunk_length_s=30 enables long-form transcription for whisper
                # (audio > 30s is split into chunks automatically).
                return pipeline(
                    "automatic-speech-recognition",
                    model=model_path,
                    chunk_length_s=30,
                    device="cpu",
                )
            _LOCAL_ASR_CACHE[model_path] = await asyncio.to_thread(_load)

    pipe = _LOCAL_ASR_CACHE[model_path]

    def _transcribe():
        import soundfile as sf
        # Decode audio bytes to float32 numpy array
        try:
            audio, sr = sf.read(io.BytesIO(audio_bytes))
        except Exception:
            # Maybe it's raw PCM — try as WAV
            import librosa
            audio, sr = librosa.load(io.BytesIO(audio_bytes), sr=None, mono=True)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        audio = audio.astype("float32")
        # Whisper expects 16kHz
        if sr != 16000:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
        result = pipe({"raw": audio, "sampling_rate": 16000})
        return result.get("text", "") if isinstance(result, dict) else str(result)

    return await asyncio.to_thread(_transcribe)


# ─── Public API ───────────────────────────────────────────────────────────────

async def transcribe(audio_b64: str, fmt: str,
                     settings: Optional[ClientSettings]) -> str:
    """Transcribe base64 audio to text. Routes to online or local."""
    audio_bytes = base64_to_bytes(audio_b64)
    asr_cfg = settings.asr if settings and settings.asr else None
    mode = asr_cfg.mode if asr_cfg else "api"

    if mode == "local" and asr_cfg and asr_cfg.modelPath:
        try:
            return await _local_asr(audio_bytes, settings, asr_cfg)  # type: ignore
        except Exception as e:
            print(f"[ASR] Local failed, falling back to ZAI API: {e}")
            # Fall through to online
            pass

    return await _zai_asr(audio_bytes, settings)  # type: ignore
