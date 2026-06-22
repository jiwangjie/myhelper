"""TTS provider: online (ZAI / Edge / custom) + local.

Voice modes:
  - preset/auto : default voice (Edge) or model-picked voice (OmniVoice)
  - clone : reference audio → speaker embedding (OmniVoice / CosyVoice)
  - design : text description → speaker design (OmniVoice / CosyVoice)

Local model support:
  - OmniVoice (k2-fsa/OmniVoice): 600+ languages, voice cloning, voice design
  - CosyVoice: voice cloning, voice design, preset voices
  - ChatTTS / VITS: transformers-based TTS

Output contract for tts_stream():
  Yields dicts: {"pcm_base64": str, "seq": int, "sample_rate": int}
  - sample_rate > 0 : raw Int16 PCM at that rate (frontend AudioWorklet)
  - sample_rate == -1 : MP3 bytes (frontend plays via <audio> queue)
"""
from __future__ import annotations

import asyncio
import io
import os
import base64
import tempfile
from typing import Any, AsyncGenerator, Optional

import httpx

from ..config import SAMPLE_RATE, TTS_MAX_CHARS, ZAI_CONFIG
from ..schemas import ClientSettings, ModelConfig
from ..utils.audio import base64_to_bytes, bytes_to_base64, float32_to_pcm_int16
from .base import (_get_shared_client, http_post_json, is_rate_limited,
                   is_zai_configured, make_zai_headers, zai_base_url)


# ─── Model type detection ─────────────────────────────────────────────────────

def _detect_model_type(model_path: str) -> str:
    """Detect local TTS model type from path/name/config.

    Returns: "omnivoice" | "cosyvoice"
    """
    # 1. Check config.json for explicit model_type
    config_path = os.path.join(model_path, "config.json")
    if os.path.isfile(config_path):
        try:
            import json
            with open(config_path) as f:
                cfg = json.load(f)
            model_type = cfg.get("model_type", "")
            if model_type == "omnivoice" or "OmniVoice" in cfg.get("architectures", []):
                return "omnivoice"
            if "CosyVoice" in model_type:
                return "cosyvoice"
        except Exception:
            pass

    # 2. Check path components for keywords
    path_lower = model_path.lower()
    if "omnivoice" in path_lower:
        return "omnivoice"

    # 3. Check for CosyVoice-specific files
    if os.path.isdir(model_path):
        files = os.listdir(model_path)
        if any(f.endswith(".onnx") for f in files) or "campplus.onnx" in files:
            return "cosyvoice"
        # Check subdirectories for CosyVoice-BlankEN
        if any("cosyvoice" in f.lower() for f in files):
            return "cosyvoice"

    # 4. Default: try CosyVoice (most common local TTS framework)
    return "cosyvoice"


# ─── Online TTS ───────────────────────────────────────────────────────────────

async def _zai_tts(text: str, settings: ClientSettings) -> tuple[bytes, int]:
    """Call ZAI TTS, return (pcm_bytes, sample_rate)."""
    if not is_zai_configured():
        raise RuntimeError("ZAI API 未配置")
    url = f"{zai_base_url()}/audio/tts"
    voice = settings.ttsVoice or "tongtong"
    body: dict[str, Any] = {
        "input": text[:TTS_MAX_CHARS],
        "voice": voice,
        "speed": max(0.5, min(2.0, float(settings.ttsSpeed))),
        "volume": max(0.1, min(10.0, float(settings.ttsVolume))),
        "response_format": "pcm",
        "stream": False,
    }
    # Include TTS model if user selected one
    tts_cfg = settings.tts if settings.tts else None
    if tts_cfg and tts_cfg.modelName:
        body["model"] = tts_cfg.modelName
    if settings.voiceMode == "clone" and settings.cloneRefAudio:
        body["reference_audio"] = settings.cloneRefAudio
    if settings.voiceMode == "design" and settings.voiceDesignPrompt:
        body["instruct_text"] = settings.voiceDesignPrompt

    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            client = _get_shared_client()
            r = await client.post(url, headers=make_zai_headers(), json=body)
            if r.status_code == 429:
                raise httpx.HTTPStatusError("429", request=r.request, response=r)
            r.raise_for_status()
            return r.content, SAMPLE_RATE
        except Exception as e:
            last_err = e
            if is_rate_limited(e) and attempt < 2:
                await asyncio.sleep(1.0 * (2 ** attempt))
                continue
            raise
    raise last_err or RuntimeError("TTS 请求失败")


async def _custom_tts(text: str, settings: ClientSettings) -> tuple[bytes, int]:
    """Call a user-configured custom TTS API."""
    api_url = (settings.customApiUrl or "").strip()
    api_key = (settings.customApiKey or "").strip()
    if not api_url:
        raise RuntimeError("自定义 TTS API 未配置 URL")
    url = f"{api_url.rstrip('/')}/audio/tts"
    voice = settings.ttsVoice or "default"
    body: dict[str, Any] = {
        "input": text[:TTS_MAX_CHARS],
        "voice": voice,
        "speed": max(0.5, min(2.0, float(settings.ttsSpeed))),
        "volume": max(0.1, min(10.0, float(settings.ttsVolume))),
        "response_format": "pcm",
        "stream": False,
    }
    if settings.voiceMode == "clone" and settings.cloneRefAudio:
        body["reference_audio"] = settings.cloneRefAudio
    if settings.voiceMode == "design" and settings.voiceDesignPrompt:
        body["instruct_text"] = settings.voiceDesignPrompt
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            client = _get_shared_client()
            r = await client.post(url, headers=headers, json=body)
            if r.status_code == 429:
                raise httpx.HTTPStatusError("429", request=r.request, response=r)
            r.raise_for_status()
            return r.content, SAMPLE_RATE
        except Exception as e:
            last_err = e
            if is_rate_limited(e) and attempt < 2:
                await asyncio.sleep(1.0 * (2 ** attempt))
                continue
            raise
    raise last_err or RuntimeError("自定义 TTS 请求失败")


async def _edge_tts(text: str, settings: ClientSettings) -> tuple[bytes, int]:
    """Synthesize MP3 via edge-tts. Returns (mp3_bytes, -1)."""
    import edge_tts
    voice = settings.ttsVoice or "zh-CN-XiaoxiaoNeural"
    speed = float(settings.ttsSpeed)
    volume = float(settings.ttsVolume)
    rate_str = "+0%" if abs(speed - 1.0) < 0.01 else f"{'+' if speed > 1 else ''}{int((speed - 1) * 100)}%"
    vol_str = "+0%" if abs(volume - 1.0) < 0.01 else f"{'+' if volume > 1 else ''}{int((volume - 1) * 100)}%"
    communicate = edge_tts.Communicate(text=text[:TTS_MAX_CHARS], voice=voice, rate=rate_str, volume=vol_str)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    mp3 = buf.getvalue()
    if not mp3:
        raise RuntimeError("Edge TTS 返回空音频")
    return mp3, -1


# ─── Local TTS ────────────────────────────────────────────────────────────────

_LOCAL_TTS_CACHE: dict[str, Any] = {}
_TTS_LOAD_LOCKS: dict[str, asyncio.Lock] = {}


def _decode_ref_audio_to_pcm(ref_audio_b64: str) -> tuple[bytes, int]:
    """Decode a base64 reference audio to (pcm_bytes, sample_rate)."""
    raw = base64_to_bytes(ref_audio_b64)
    try:
        import soundfile as sf
        audio, sr = sf.read(io.BytesIO(raw))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        audio = audio.astype("float32")
        from ..utils.audio import float32_to_pcm_int16
        return float32_to_pcm_int16(audio), int(sr)
    except Exception:
        pass
    # Fallback: treat as MP3
    return mp3_to_pcm(raw, target_sample_rate=16000)


def _load_local_model(model_path: str) -> tuple[str, Any]:
    """Load a local TTS model. Returns (model_type, model_instance)."""
    model_type = _detect_model_type(model_path)

    if model_type == "omnivoice":
        from omnivoice import OmniVoice
        import torch
        use_gpu = torch.cuda.is_available()
        dtype = torch.float16 if use_gpu else torch.float32
        model = OmniVoice.from_pretrained(
            model_path,
            device_map="cuda:0" if use_gpu else "cpu",
            dtype=dtype,
        )
        return ("omnivoice", model)

    # CosyVoice
    from cosyvoice import CosyVoice
    model = CosyVoice(model_path, load_jit=True, load_trt=False)
    return ("cosyvoice", model)


async def _local_tts(text: str, settings: ClientSettings,
                     tts_cfg: ModelConfig) -> tuple[bytes, int]:
    """Run a local TTS model. Handles all model types uniformly."""
    if not tts_cfg.modelPath:
        raise RuntimeError("本地 TTS 未指定模型路径")

    model_path = tts_cfg.modelPath
    model_type = _detect_model_type(model_path)

    lock = _TTS_LOAD_LOCKS.get(model_path)
    if lock is None:
        lock = asyncio.Lock()
        _TTS_LOAD_LOCKS[model_path] = lock

    async with lock:
        if model_path not in _LOCAL_TTS_CACHE:
            _LOCAL_TTS_CACHE[model_path] = await asyncio.to_thread(
                _load_local_model, model_path
            )
    _, model = _LOCAL_TTS_CACHE[model_path]

    voice_mode = settings.voiceMode or "preset"

    def _synth() -> tuple[bytes, int]:
        import traceback as _tb
        import numpy as np

        if model_type == "omnivoice":
            kwargs: dict[str, Any] = {"text": text}
            if settings.ttsVoice:
                voice = settings.ttsVoice.lower()
                if len(voice) <= 3:
                    kwargs["language"] = settings.ttsVoice
            if voice_mode == "clone" and settings.cloneRefAudio:
                ref_bytes = base64_to_bytes(settings.cloneRefAudio)
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp.write(ref_bytes)
                    tmp_path = tmp.name
                try:
                    kwargs["ref_audio"] = tmp_path
                    kwargs["ref_text"] = "Reference audio for voice cloning."
                    audios = model.generate(**kwargs)
                finally:
                    os.unlink(tmp_path)
            elif voice_mode == "design" and settings.voiceDesignPrompt:
                kwargs["instruct"] = settings.voiceDesignPrompt
                audios = model.generate(**kwargs)
            else:
                audios = model.generate(**kwargs)
            if not audios:
                raise RuntimeError("OmniVoice 未生成音频数据")
            audio_np = audios[0].astype(np.float32)
            return float32_to_pcm_int16(audio_np), 24000

        elif model_type == "cosyvoice":
            if voice_mode == "clone" and settings.cloneRefAudio:
                ref_pcm, ref_sr = _decode_ref_audio_to_pcm(settings.cloneRefAudio)
                ref_float32 = np.frombuffer(ref_pcm, dtype=np.int16).astype(np.float32) / 32768.0
                output = model.inference_zero_shot(
                    text, utterance_to_k={"speech": ref_float32, "sr": ref_sr},
                )
            elif voice_mode == "design" and settings.voiceDesignPrompt:
                output = model.inference_instruct(text, instruction=settings.voiceDesignPrompt)
            else:
                output = model.inference_sft(text)
            audio = output.get("tts_speech", np.array([]))
            sr = output.get("sr", 24000)
            pcm = float32_to_pcm_int16(np.asarray(audio).flatten().astype(np.float32))
            return pcm, int(sr)

        elif model_type == "transformers":
            tok, tts_model = model
            import torch
            inputs = tok(text, return_tensors="pt")
            with torch.no_grad():
                out = tts_model(**inputs).waveform
            pcm = float32_to_pcm_int16(out.numpy().astype(np.float32))
            sr = getattr(getattr(tts_model, "config", None), "sampling_rate", 24000)
            return pcm, int(sr)

        else:  # pipeline
            r = model(text)
            if isinstance(r, dict):
                audio = r.get("audio")
                sr = r.get("sampling_rate", 24000)
            else:
                audio = getattr(r, "audio", None)
                sr = getattr(r, "sampling_rate", 24000)
            pcm = float32_to_pcm_int16(np.asarray(audio).flatten().astype(np.float32))
            return pcm, int(sr)

    try:
        return await asyncio.to_thread(_synth)
    except Exception as e:
        import traceback
        print(f"[TTS] synth failed ({model_type}): {e}")
        print(traceback.format_exc())
        raise


# ─── Public API ───────────────────────────────────────────────────────────────

async def tts_stream(text: str, seq: int,
                     settings: ClientSettings) -> AsyncGenerator[dict, None]:
    """Synthesize `text` and yield audio chunk(s)."""
    if not text:
        return

    tts_cfg = settings.tts
    mode = tts_cfg.mode if tts_cfg else "api"
    provider = settings.ttsApiProvider or "edge"

    audio_bytes: Optional[bytes] = None
    sample_rate: int = SAMPLE_RATE

    if mode == "local" and tts_cfg and tts_cfg.modelPath:
        try:
            audio_bytes, sample_rate = await _local_tts(text, settings, tts_cfg)
        except Exception as e:
            print(f"[TTS] Local failed, falling back to online: {e}")
            audio_bytes = None

    if audio_bytes is None:
        if provider == "edge":
            try:
                audio_bytes, sample_rate = await _edge_tts(text, settings)
            except Exception as e:
                print(f"[TTS] Edge TTS failed, falling back to ZAI: {e}")
                audio_bytes, sample_rate = await _zai_tts(text, settings)
        elif provider == "custom":
            audio_bytes, sample_rate = await _custom_tts(text, settings)
        else:
            audio_bytes, sample_rate = await _zai_tts(text, settings)

    if not audio_bytes:
        raise RuntimeError("TTS 未产生音频数据")

    yield {
        "pcm_base64": bytes_to_base64(audio_bytes),
        "seq": seq,
        "sample_rate": sample_rate,
    }
