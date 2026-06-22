"""AI Pipeline Python backend — FastAPI + python-socketio entrypoint.

Routes:
  REST:
    GET  /api/health              -> service health + runtime availability
    GET  /api/tts/voices          -> {provider, defaultVoice, voices, modes}
    GET  /api/models              -> locally-available models + suggested
    GET  /api/config/defaults     -> default per-service config (for text boxes)
    POST /api/models/download     -> kick off HF download (REST alternative to WS)

  WebSocket (socket.io):
    Client → Server: chat, asr, interrupt, image, regenerate_image, download_model
    Server → Client: warmup_done, llm_chunk, llm_end, audio_chunk, audio_end,
                     image_start, image_done, asr_result, model_status, error,
                     model_downloaded, download_progress
"""
from __future__ import annotations

import os
from typing import Any

import socketio
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import (DEFAULT_CONFIGS, DEFAULT_TTS_SETTINGS, DEFAULT_VOICE_PER_PROVIDER,
                       DEFAULT_VOICE_LOCAL, DEFAULT_ZAI_API_URL, EDGE_VOICE_PRESETS,
                       SUGGESTED_LOCAL_MODELS, VOICE_LIST_LOCAL, VOICE_MODES_LOCAL,
                       VOICE_MODES_PER_PROVIDER, ZAI_CONFIG, ZAI_VOICE_PRESETS)
from .models_registry import list_local_models, local_runtimes_available
from .schemas import (ClientSettings, DownloadModelRequest, HealthResponse,
                       LocalModelsResponse, VoiceListResponse)
from .ws.handler import (handle_asr, handle_chat, handle_disconnect,
                          handle_download_model, handle_image, handle_interrupt,
                          handle_regenerate_image, handle_connect)

# ─── FastAPI app ──────────────────────────────────────────────────────────────
app = FastAPI(title="AI Pipeline Python", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Socket.IO server (AsyncServer, ASGI) ─────────────────────────────────────
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_timeout=120,
    ping_interval=25,
)

# Register event handlers
@sio.event
async def connect(sid, environ):
    await handle_connect(sio, sid)


@sio.event
async def disconnect(sid):
    await handle_disconnect(sio, sid)


@sio.on("chat")
async def on_chat(sid, data):
    await handle_chat(sio, sid, data or {})


@sio.on("asr")
async def on_asr(sid, data):
    await handle_asr(sio, sid, data or {})


@sio.on("interrupt")
async def on_interrupt(sid, data=None):
    await handle_interrupt(sio, sid)


@sio.on("image")
async def on_image(sid, data):
    await handle_image(sio, sid, data or {})


@sio.on("regenerate_image")
async def on_regenerate_image(sid, data):
    await handle_regenerate_image(sio, sid, data or {})


@sio.on("download_model")
async def on_download_model(sid, data):
    await handle_download_model(sio, sid, data or {})


# Mount socket.io ASGI app at root (so socket.io path is /socket.io)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# ─── REST endpoints ───────────────────────────────────────────────────────────

@app.get("/api/health")
async def get_health():
    runtimes = local_runtimes_available()
    return HealthResponse(
        status="ok",
        zai_configured=bool(ZAI_CONFIG.get("baseUrl") and ZAI_CONFIG.get("apiKey")),
        local_runtimes=runtimes,
    )


@app.get("/api/tts/voices")
async def get_tts_voices(
    provider: str = Query("zai", description="edge | zai | custom"),
    mode: str = Query("api", description="api | local — determines which mode list to return"),
):
    """Return the default voice list + supported modes for a TTS provider.

    The frontend SettingsDialog calls this when the user switches TTS provider
    or service mode (在线 API / 本地模型), so the dropdown shows the correct
    voices and the supported voice modes (preset / clone / design).

    - In **api** mode: voices come from the provider's preset list; modes are
      provider-specific (Edge → preset only; ZAI/custom → all three).
    - In **local** mode: voices list is empty (user picks a local model);
      modes are all three (preset/clone/design) — local TTS frameworks can
      support clone/design via their own mechanisms.
    """
    if mode == "local":
        # Local-model mode: expose the default preset voice (the model's own
        # default speaker) so the UI dropdown shows something selectable.
        # All three voice modes (preset / clone / design) are selectable:
        #   - preset  → use the model's built-in default voice
        #   - clone   → user provides a reference audio sample
        #   - design → user provides a text description of the desired voice
        return VoiceListResponse(
            provider=provider,
            defaultVoice=DEFAULT_VOICE_LOCAL,
            voices=VOICE_LIST_LOCAL,
            modes=VOICE_MODES_LOCAL,
        )

    # Online API mode
    if provider == "edge":
        voices = EDGE_VOICE_PRESETS
    elif provider == "zai":
        voices = ZAI_VOICE_PRESETS
    else:  # custom
        # Custom provider: user supplies their own voice names; expose a default
        # preset voice so the UI always has a selectable option.
        voices = [{"value": "default", "label": "默认音色"}]

    return VoiceListResponse(
        provider=provider,
        defaultVoice=DEFAULT_VOICE_PER_PROVIDER.get(provider, ""),
        voices=voices,
        modes=VOICE_MODES_PER_PROVIDER.get(provider, ["preset"]),
    )


@app.get("/api/models")
async def get_local_models():
    """Return locally-available models (auto-scanned) + suggested HF models."""
    local = list_local_models()
    return LocalModelsResponse(
        llm=local["llm"],
        asr=local["asr"],
        tts=local["tts"],
        image=local["image"],
        suggested=SUGGESTED_LOCAL_MODELS,
    )


@app.get("/api/config/defaults")
async def get_config_defaults():
    """Return the default per-service config so the frontend can populate
    the settings text boxes on first load.

    This satisfies the requirement: "软件llm, asr, tts, image内置默认在线API
    信息应当正确加载到对应文本框中" (built-in default online API info should be
    correctly loaded into the corresponding text boxes).
    """
    return JSONResponse({
        "configs": DEFAULT_CONFIGS,
        "ttsSettings": DEFAULT_TTS_SETTINGS,
        "zaiApiUrl": DEFAULT_ZAI_API_URL,
        "zaiConfigured": bool(ZAI_CONFIG.get("baseUrl") and ZAI_CONFIG.get("apiKey")),
    })


@app.post("/api/models/download")
async def rest_download_model(req: DownloadModelRequest):
    """REST alternative to the WS download_model event.

    Returns immediately. Progress and completion are reported only via WS
    events — REST callers should also connect to the WebSocket to receive
    `model_downloaded` / `error` notifications. Server-side logging captures
    outcomes for debugging.
    """
    from .models_registry import download_model as hf_download_model
    import asyncio
    import logging
    log = logging.getLogger("ai-pipeline-python")

    async def _logging_emit(event: str, data: Any) -> None:
        if event == "model_downloaded":
            log.info("[REST download] success: %s/%s", req.service, req.modelName)
        elif event == "error":
            log.warning("[REST download] failed: %s/%s — %s", req.service, req.modelName, data)

    # Store a strong reference to prevent GC from cancelling the task.
    from .models_registry import _background_tasks
    task = asyncio.create_task(hf_download_model(req.modelName, req.service, "rest", _logging_emit))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"status": "started", "modelName": req.modelName, "service": req.service}


# ─── ASGI app ─────────────────────────────────────────────────────────────────
# The module exposes BOTH:
#   app        → FastAPI REST app (for testing / REST-only deployments)
#   socket_app → Combined ASGI app (REST + WebSocket, for production)
#
# uvicorn app.main:socket_app  (serves both REST + WS on the same port)
# uvicorn app.main:app         (REST-only, for debugging)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(socket_app, host="0.0.0.0", port=3003, log_level="info")
