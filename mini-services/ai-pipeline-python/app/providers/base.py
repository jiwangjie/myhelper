"""Provider base classes and shared helpers."""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..config import ZAI_CONFIG

# Shared persistent HTTP client for connection pooling (avoids TLS handshake overhead)
_shared_http_client: Optional[httpx.AsyncClient] = None


def _get_shared_client() -> httpx.AsyncClient:
    global _shared_http_client
    if _shared_http_client is None or _shared_http_client.is_closed:
        _shared_http_client = httpx.AsyncClient(
            timeout=60.0,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _shared_http_client


def make_zai_headers(extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Build Authorization + X-* headers for ZAI API calls."""
    h = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ZAI_CONFIG.get('apiKey', '')}",
        "X-Z-AI-From": "Z",
    }
    if ZAI_CONFIG.get("chatId"):
        h["X-Chat-Id"] = ZAI_CONFIG["chatId"]
    if ZAI_CONFIG.get("userId"):
        h["X-User-Id"] = ZAI_CONFIG["userId"]
    if ZAI_CONFIG.get("token"):
        h["X-Token"] = ZAI_CONFIG["token"]
    if extra:
        h.update(extra)
    return h


def zai_base_url() -> str:
    """Return the ZAI base URL (internal or user-overridden)."""
    return ZAI_CONFIG.get("baseUrl", "")


def is_zai_configured() -> bool:
    return bool(ZAI_CONFIG.get("baseUrl") and ZAI_CONFIG.get("apiKey"))


async def http_post_json(url: str, headers: dict[str, str], body: dict[str, Any],
                         timeout: float = 60.0) -> httpx.Response:
    client = _get_shared_client()
    return await client.post(url, headers=headers, json=body)


async def http_get_bytes(url: str, timeout: float = 60.0) -> bytes:
    client = _get_shared_client()
    r = await client.get(url)
    r.raise_for_status()
    return r.content


def is_rate_limited(err: Exception) -> bool:
    """Detect 429 rate-limit errors from httpx/HTTPStatusError messages."""
    msg = str(err).lower()
    return "429" in msg or "too many requests" in msg
