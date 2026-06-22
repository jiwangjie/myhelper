"""Pydantic schemas for client/server settings and messages.

Mirrors the TypeScript types in src/lib/chat-store.ts so the wire protocol
stays identical to v8 (no frontend protocol changes needed).
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# ─── Per-service model config ─────────────────────────────────────────────────
ModelMode = Literal["api", "local"]
VoiceMode = Literal["preset", "clone", "design"]
TtsApiProvider = Literal["edge", "zai", "custom"]


class ModelConfig(BaseModel):
    mode: ModelMode = "api"
    enabled: bool = True
    apiUrl: str = ""
    apiKey: str = ""
    modelName: str = ""
    modelPath: str = ""
    systemPrompt: str = ""
    apiParams: dict[str, Any] = Field(default_factory=dict)
    extraParams: dict[str, Any] = Field(default_factory=dict)


class ClientSettings(BaseModel):
    """Full settings payload sent from the frontend with each WS event."""
    # Per-service configs
    llm: Optional[ModelConfig] = None
    asr: Optional[ModelConfig] = None
    tts: Optional[ModelConfig] = None
    image: Optional[ModelConfig] = None

    # TTS top-level
    ttsApiProvider: TtsApiProvider = "zai"
    ttsVoice: str = "tongtong"
    ttsSpeed: float = 1.0
    ttsVolume: float = 1.0
    voiceMode: VoiceMode = "preset"
    cloneRefAudio: str = ""
    voiceDesignPrompt: str = ""

    # Custom provider API config (used when ttsApiProvider == "custom")
    customApiUrl: str = ""
    customApiKey: str = ""

    # Image top-level
    imageSize: str = "1024x1024"
    imageUseReference: bool = False
    imageReferenceImage: str = ""

    # Allow extra fields for forward compatibility
    model_config = {"extra": "allow"}


# ─── WS event payloads ────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    text: str
    messages: list[dict[str, str]] = Field(default_factory=list)
    settings: Optional[ClientSettings] = None


class AsrRequest(BaseModel):
    audio: str  # base64
    format: str = "wav"
    settings: Optional[ClientSettings] = None


class ImageRequest(BaseModel):
    prompt: str
    settings: Optional[ClientSettings] = None


class RegenerateImageRequest(BaseModel):
    messageId: str
    actionText: str
    settings: Optional[ClientSettings] = None


class DownloadModelRequest(BaseModel):
    url: Optional[str] = ""          # explicit URL (optional)
    service: str                      # llm | asr | tts | image
    modelName: str                    # HF repo id or model name


# ─── REST response schemas ────────────────────────────────────────────────────
class VoiceListResponse(BaseModel):
    provider: str
    defaultVoice: str
    voices: list[dict[str, str]]
    modes: list[str]


class LocalModelsResponse(BaseModel):
    llm: list[str]
    asr: list[str]
    tts: list[str]
    image: list[str]
    suggested: dict[str, list[str]]


class ServiceStatusResponse(BaseModel):
    service: str
    status: Literal["ready", "generating", "processing", "error"]
    message: Optional[str] = None


class HealthResponse(BaseModel):
    status: str = "ok"
    zai_configured: bool
    local_runtimes: dict[str, bool]
