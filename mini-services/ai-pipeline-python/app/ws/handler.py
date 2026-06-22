"""WebSocket event handlers (socket.io protocol, mirrors v8 Node backend).

Server → Client events:
  warmup_done, llm_chunk, llm_end, audio_chunk, audio_end,
  image_start, image_done, asr_result, model_status, error,
  model_downloaded, download_progress

Client → Server events:
  chat, asr, interrupt, image, regenerate_image, download_model
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Optional

import socketio

from ..config import (DEFAULT_SYSTEM_PROMPT, MAX_HISTORY, SAMPLE_RATE,
                       TTS_MAX_CHARS)
from ..models_registry import download_model as hf_download_model
from ..providers import (asr_provider, image_provider, llm_provider,
                          tts_provider)
from ..schemas import (AsrRequest, ChatRequest, ClientSettings,
                        DownloadModelRequest, ImageRequest,
                        RegenerateImageRequest)
from ..utils.text import (extract_actions, split_into_sentences,
                           strip_actions)


def _log(sid: str, msg: str):
    """Print a timestamped, sid-prefixed log line for conversation tracking."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}][{sid[:8]}] {msg}")

# Per-sid state: {current_task: Optional[asyncio.Task], history: [...]}
_CONN_STATE: dict[str, dict[str, Any]] = {}


def _emit_factory(sio: socketio.AsyncServer, sid: str):
    async def _emit(event: str, data: Any):
        await sio.emit(event, data, to=sid)
    return _emit


# ─── Chat handler (the main pipeline) ─────────────────────────────────────────

async def handle_chat(sio: socketio.AsyncServer, sid: str, raw: dict[str, Any]):
    """Process a chat request: LLM → (stream text) → TTS + Image (parallel)."""
    state = _CONN_STATE.setdefault(sid, {"current_task": None, "history": []})
    t0 = time.time()
    try:
        req = ChatRequest(**raw)
    except Exception as e:
        await sio.emit("error", f"无效的 chat 请求：{e}", to=sid)
        return

    text = (req.text or "").strip()
    if not text:
        await sio.emit("error", "Empty text", to=sid)
        return

    settings = req.settings or ClientSettings()
    client_messages = req.messages or []

    # Log model execution info
    llm_mode = settings.llm.mode if settings.llm else "api"
    llm_path = settings.llm.modelPath[:50] if settings.llm and settings.llm.modelPath else "default"
    tts_mode = settings.tts.mode if settings.tts else "api"
    tts_path = settings.tts.modelPath[:50] if settings.tts and settings.tts.modelPath else "default"
    _log(sid, f"📝 User: {text[:80]}{'...' if len(text) > 80 else ''}")
    _log(sid, f"🤖 LLM: mode={llm_mode}, model={llm_path}...")
    _log(sid, f"🔊 TTS: mode={tts_mode}, model={tts_path}...")

    # Cancel previous task
    prev = state.get("current_task")
    if prev and not prev.done():
        prev.cancel()

    # Resolve system prompt
    system_prompt = (
        settings.llm.systemPrompt if settings.llm and settings.llm.systemPrompt
        else DEFAULT_SYSTEM_PROMPT
    )

    # Build messages for LLM
    messages: list[dict[str, str]] = []
    has_system = any(m.get("role") == "system" for m in client_messages)
    if not has_system:
        messages.append({"role": "system", "content": system_prompt})
    for m in client_messages:
        if m.get("role") in ("user", "assistant", "system") and m.get("content"):
            messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": text})

    # Store user message in history
    state["history"].append({"role": "user", "content": text})
    if len(state["history"]) > MAX_HISTORY * 2:
        state["history"] = state["history"][-MAX_HISTORY:]

    # Store reference to current task for cancellation via handle_interrupt.
    task: asyncio.Task = asyncio.current_task()  # type: ignore
    state["current_task"] = task

    emit = _emit_factory(sio, sid)

    tts_enabled = settings.tts.enabled if settings.tts else True
    image_enabled = settings.image.enabled if settings.image else True

    await sio.emit("model_status", {"service": "llm", "status": "generating"}, to=sid)

    full_response = ""
    try:
        # ─── Phase 1: LLM ───────────────────────────────────────────────────
        llm_t0 = time.time()
        response_text = await llm_provider.generate_completion(messages, settings)
        llm_dt = time.time() - llm_t0
        await sio.emit("model_status", {"service": "llm", "status": "ready"}, to=sid)

        if response_text:
            for sentence in split_into_sentences(response_text):
                # Strip <action> tags from streamed chunks to avoid visual flicker
                clean_sentence = strip_actions(sentence)
                if clean_sentence:
                    await sio.emit("llm_chunk", clean_sentence, to=sid)
                full_response += sentence
                await asyncio.sleep(0.03)

        actions = extract_actions(full_response)
        display_text = strip_actions(full_response)
        # Always emit llm_end (even on empty response) so frontend can finalize
        await sio.emit("llm_end", {"text": display_text, "actions": actions}, to=sid)
        _log(sid, f"🤖 LLM done ({llm_dt:.1f}s): {display_text[:80]}{'...' if len(display_text) > 80 else ''}")

        # ─── Phase 2: TTS + Image (parallel) ────────────────────────────────
        tts_task = asyncio.create_task(_run_tts_phase(sio, sid, display_text,
                                                      settings, emit))
        image_task = asyncio.create_task(_run_image_phase(sio, sid, actions,
                                                          settings, emit))
        await asyncio.gather(tts_task, image_task, return_exceptions=True)

        # Store assistant reply in history
        state["history"].append({"role": "assistant", "content": display_text})
        total_dt = time.time() - t0
        _log(sid, f"✅ Done ({total_dt:.1f}s)")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        _log(sid, f"❌ Error: {e}")
        await sio.emit("error", f"Pipeline Error: {e}", to=sid)
        await sio.emit("model_status", {"service": "llm", "status": "ready"}, to=sid)
    finally:
        if state.get("current_task") is task:
            state["current_task"] = None


async def _run_tts_phase(sio: socketio.AsyncServer, sid: str, display_text: str,
                         settings: ClientSettings, emit):
    """Generate TTS for the full display text (post-LLM)."""
    tts_enabled = settings.tts.enabled if settings.tts else True
    if not tts_enabled or not display_text:
        return
    tts_t0 = time.time()
    model_type = "api"
    if settings.tts and settings.tts.modelPath:
        model_type = tts_provider._detect_model_type(settings.tts.modelPath)
    try:
        await sio.emit("model_status", {"service": "tts", "status": "generating"}, to=sid)

        if len(display_text) <= TTS_MAX_CHARS:
            await _run_tts_for_text(sio, sid, display_text, 1, settings)
        else:
            seq = 0
            for sentence in split_into_sentences(display_text):
                clean = strip_actions(sentence)
                if not clean:
                    continue
                seq += 1
                await _run_tts_for_text(sio, sid, clean, seq, settings)
                await asyncio.sleep(0.2)

        tts_dt = time.time() - tts_t0
        await sio.emit("audio_end", "", to=sid)
        await sio.emit("model_status", {"service": "tts", "status": "ready"}, to=sid)
        _log(sid, f"🔊 TTS done ({tts_dt:.1f}s, type={model_type})")
    except Exception as e:
        _log(sid, f"❌ TTS error: {e}")
        await sio.emit("error", f"语音合成失败：{e}", to=sid)
        await sio.emit("audio_end", "", to=sid)
        await sio.emit("model_status", {"service": "tts", "status": "ready"}, to=sid)


async def _run_tts_for_text(sio: socketio.AsyncServer, sid: str, text: str,
                            seq: int, settings: ClientSettings):
    """Generate TTS for a single text chunk, emit audio_chunk events."""
    try:
        async for chunk in tts_provider.tts_stream(text, seq, settings):
            await sio.emit("audio_chunk", {
                "data": chunk["pcm_base64"],
                "seq": chunk["seq"],
                "sample_rate": chunk["sample_rate"],
            }, to=sid)
    except Exception as e:
        _log(sid, f"❌ TTS seq #{seq} failed: {e}")
        await sio.emit("error", f"语音合成失败：{e}", to=sid)


async def _run_image_phase(sio: socketio.AsyncServer, sid: str,
                           actions: list[str], settings: ClientSettings,
                           emit):
    """Generate character illustration based on first <action> tag."""
    image_enabled = settings.image.enabled if settings.image else True
    if not image_enabled or not actions:
        return
    try:
        await sio.emit("image_start", "", to=sid)
        await sio.emit("model_status", {"service": "image", "status": "generating"}, to=sid)

        prompt = await llm_provider.translate_action_to_prompt(actions[0], settings)
        size = settings.imageSize or (
            settings.image.extraParams.get("size") if settings.image else None
        ) or "1024x1024"
        image_url = await image_provider.generate_image(prompt, size, settings)
        await sio.emit("image_done", image_url, to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)
    except Exception as e:
        print(f"[Image] Generation failed: {e}")
        await sio.emit("error", f"Image Error: {e}", to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)


# ─── ASR handler ──────────────────────────────────────────────────────────────

async def handle_asr(sio: socketio.AsyncServer, sid: str, raw: dict[str, Any]):
    try:
        req = AsrRequest(**raw)
    except Exception as e:
        await sio.emit("error", f"无效的 asr 请求：{e}", to=sid)
        return
    asr_enabled = req.settings.asr.enabled if req.settings and req.settings.asr else True
    if not asr_enabled:
        await sio.emit("error", "ASR service is disabled", to=sid)
        return
    if not req.audio:
        await sio.emit("error", "ASR: 无音频数据", to=sid)
        return
    try:
        await sio.emit("model_status", {"service": "asr", "status": "processing"}, to=sid)
        text = await asr_provider.transcribe(req.audio, req.format, req.settings)
        await sio.emit("asr_result", text or "", to=sid)
        await sio.emit("model_status", {"service": "asr", "status": "ready"}, to=sid)
    except Exception as e:
        print(f"[ASR] Error: {e}")
        await sio.emit("error", f"ASR Error: {e}", to=sid)
        await sio.emit("model_status", {"service": "asr", "status": "ready"}, to=sid)


# ─── Image handler (manual image generation) ──────────────────────────────────

async def handle_image(sio: socketio.AsyncServer, sid: str, raw: dict[str, Any]):
    try:
        req = ImageRequest(**raw)
    except Exception as e:
        await sio.emit("error", f"无效的 image 请求：{e}", to=sid)
        return
    image_enabled = req.settings.image.enabled if req.settings and req.settings.image else True
    if not image_enabled:
        await sio.emit("error", "Image service is disabled", to=sid)
        return
    prompt = (req.prompt or "").strip()
    if not prompt:
        await sio.emit("error", "Image: 无 prompt", to=sid)
        return
    try:
        await sio.emit("image_start", "", to=sid)
        await sio.emit("model_status", {"service": "image", "status": "generating"}, to=sid)
        size = (req.settings.imageSize if req.settings else None) or \
               (req.settings.image.extraParams.get("size") if req.settings and req.settings.image else None) or \
               "1024x1024"
        image_url = await image_provider.generate_image(prompt, size, req.settings)
        await sio.emit("image_done", image_url, to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)
    except Exception as e:
        print(f"[Image] Error: {e}")
        await sio.emit("error", f"Image Error: {e}", to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)


# ─── Regenerate image handler ─────────────────────────────────────────────────

async def handle_regenerate_image(sio: socketio.AsyncServer, sid: str, raw: dict[str, Any]):
    try:
        req = RegenerateImageRequest(**raw)
    except Exception as e:
        await sio.emit("error", f"无效的 regenerate_image 请求：{e}", to=sid)
        return
    image_enabled = req.settings.image.enabled if req.settings and req.settings.image else True
    if not image_enabled:
        await sio.emit("error", "Image service is disabled", to=sid)
        return
    action_text = (req.actionText or "").strip()
    if not action_text:
        await sio.emit("error", "重新生成图片：缺少动作描述", to=sid)
        return
    try:
        await sio.emit("image_start", {"messageId": req.messageId}, to=sid)
        await sio.emit("model_status", {"service": "image", "status": "generating"}, to=sid)
        prompt = await llm_provider.translate_action_to_prompt(action_text, req.settings)
        size = (req.settings.imageSize if req.settings else None) or \
               (req.settings.image.extraParams.get("size") if req.settings and req.settings.image else None) or \
               "1024x1024"
        image_url = await image_provider.generate_image(prompt, size, req.settings)
        await sio.emit("image_done", {"url": image_url, "messageId": req.messageId}, to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)
    except Exception as e:
        print(f"[Image] Regenerate failed: {e}")
        await sio.emit("error", f"重新生成图片失败：{e}", to=sid)
        await sio.emit("model_status", {"service": "image", "status": "ready"}, to=sid)


# ─── Interrupt handler ────────────────────────────────────────────────────────

async def handle_interrupt(sio: socketio.AsyncServer, sid: str):
    state = _CONN_STATE.get(sid)
    if state and state.get("current_task") and not state["current_task"].done():
        # Cancel the in-flight task. Do NOT clear current_task here — let
        # handle_chat's `finally` block clear it once CancelledError propagates.
        # This avoids a race where a new chat event arrives before the
        # cancelled task finishes unwinding.
        state["current_task"].cancel()


# ─── Download model handler ───────────────────────────────────────────────────

async def handle_download_model(sio: socketio.AsyncServer, sid: str, raw: dict[str, Any]):
    try:
        req = DownloadModelRequest(**raw)
    except Exception as e:
        await sio.emit("error", f"无效的 download_model 请求：{e}", to=sid)
        return
    emit = _emit_factory(sio, sid)
    # Run download in background; report progress via WS events.
    # Store a strong reference to prevent GC from cancelling the task.
    from ..models_registry import _background_tasks
    task = asyncio.create_task(hf_download_model(req.modelName, req.service, sid, emit))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ─── Connect / Disconnect ─────────────────────────────────────────────────────

async def handle_connect(sio: socketio.AsyncServer, sid: str):
    _log(sid, "🔗 Client connected")
    # Cancel any in-flight task from a previous connection with the same SID
    old_state = _CONN_STATE.get(sid)
    if old_state and old_state.get("current_task") and not old_state["current_task"].done():
        old_state["current_task"].cancel()
    _CONN_STATE[sid] = {"current_task": None, "history": []}
    await sio.emit("warmup_done", "", to=sid)
    for svc in ("llm", "asr", "tts", "image"):
        await sio.emit("model_status", {"service": svc, "status": "ready"}, to=sid)


async def handle_disconnect(sio: socketio.AsyncServer, sid: str):
    _log(sid, "🔌 Client disconnected")
    state = _CONN_STATE.pop(sid, None)
    if state and state.get("current_task") and not state["current_task"].done():
        state["current_task"].cancel()
