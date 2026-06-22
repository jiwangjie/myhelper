"""Image provider: online (ZAI cogview) + local (diffusers).

Public API:
  async generate_image(prompt, size, settings) -> str  (returns data:image/png;base64,... URL)
"""
from __future__ import annotations

import asyncio
import base64
from typing import Any, Optional

import httpx

from ..schemas import ClientSettings, ModelConfig
from .base import (http_get_bytes, http_post_json, is_rate_limited,
                   is_zai_configured, make_zai_headers, zai_base_url)

_LOCAL_IMAGE_CACHE: dict[str, Any] = {}


# ─── Online (ZAI cogview API) ─────────────────────────────────────────────────

async def _zai_image(prompt: str, size: str,
                     system_prompt: Optional[str],
                     reference_image: Optional[str]) -> str:
    """Call ZAI images/generations, return a data:image/png;base64,... URL.

    The API returns either {data: [{url}]} or {data: [{b64_json}]}.
    We normalize to a data: URL for the frontend.
    """
    if not is_zai_configured():
        raise RuntimeError("ZAI API 未配置")

    url = f"{zai_base_url()}/images/generations"
    body: dict[str, Any] = {
        "prompt": prompt,
        "size": size or "1024x1024",
    }
    if reference_image:
        body["image"] = reference_image

    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.post(url, headers=make_zai_headers(), json=body)
                if r.status_code == 429:
                    raise httpx.HTTPStatusError(
                        "429 Too Many Requests",
                        request=r.request, response=r,
                    )
                r.raise_for_status()
                data = r.json()
                items = data.get("data", [])
                if not items:
                    raise RuntimeError("图像生成返回空数据")
                item = items[0]
                # Prefer b64_json if present
                if item.get("b64_json"):
                    return f"data:image/png;base64,{item['b64_json']}"
                if item.get("base64"):
                    return f"data:image/png;base64,{item['base64']}"
                if item.get("url"):
                    # Download the image and convert to data URL
                    img_bytes = await http_get_bytes(item["url"], timeout=60.0)
                    b64 = base64.b64encode(img_bytes).decode("ascii")
                    return f"data:image/png;base64,{b64}"
                raise RuntimeError("图像生成返回格式无法识别")
        except Exception as e:
            last_err = e
            if is_rate_limited(e) and attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
                continue
            raise
    raise last_err or RuntimeError("图像生成失败")


# ─── Local (diffusers) ────────────────────────────────────────────────────────

# Per-model locks to prevent concurrent loading.
_IMAGE_LOAD_LOCKS: dict[str, asyncio.Lock] = {}


async def _local_image(prompt: str, size: str,
                       system_prompt: Optional[str],
                       reference_image: Optional[str],
                       image_cfg: ModelConfig) -> str:
    """Generate an image via diffusers (StableDiffusion / FLUX)."""
    if not image_cfg.modelPath:
        raise RuntimeError("本地图像模型未指定路径")

    model_path = image_cfg.modelPath
    use_img2img = bool(reference_image)
    cache_key = f"{model_path}::{'img2img' if use_img2img else 'txt2img'}"

    # Per-model lock prevents concurrent loading (which would double RAM).
    lock = _IMAGE_LOAD_LOCKS.get(cache_key)
    if lock is None:
        lock = asyncio.Lock()
        _IMAGE_LOAD_LOCKS[cache_key] = lock

    async with lock:
        if cache_key not in _LOCAL_IMAGE_CACHE:
            def _load():
                try:
                    import torch
                    from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image
                except ImportError as e:
                    raise RuntimeError(
                        "本地图像运行时未安装。请运行: pip install torch diffusers"
                    ) from e
                cls = AutoPipelineForImage2Image if use_img2img else AutoPipelineForText2Image
                # CPU inference: use float32 (float16 is extremely slow on CPU and
                # offers no benefit — CPU doesn't have tensor cores).
                # For GPU, float16 would save VRAM.
                pipe = cls.from_pretrained(
                    model_path, torch_dtype=torch.float32
                )
                pipe.to("cpu")
                return pipe
            _LOCAL_IMAGE_CACHE[cache_key] = await asyncio.to_thread(_load)

    pipe = _LOCAL_IMAGE_CACHE[cache_key]

    # Parse size
    try:
        w, h = (int(x) for x in (size or "1024x1024").split("x"))
    except Exception:
        w, h = 1024, 1024
    # Round to multiple of 8 (diffusers requirement)
    w = max(64, (w // 8) * 8)
    h = max(64, (h // 8) * 8)

    full_prompt = f"{system_prompt}, {prompt}" if system_prompt else prompt
    if "masterpiece" not in full_prompt:
        full_prompt = f"{full_prompt}, masterpiece, best quality, ultra-detailed, anime style"

    def _generate():
        import torch
        with torch.no_grad():
            # img2img if reference provided
            if reference_image:
                from PIL import Image
                import io as _io
                # reference_image is a data: URL or raw base64
                if "," in reference_image and reference_image.startswith("data:"):
                    reference_image_b64 = reference_image.split(",", 1)[1]
                else:
                    reference_image_b64 = reference_image
                img_bytes = base64.b64decode(reference_image_b64)
                ref_pil = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
                ref_pil = ref_pil.resize((w, h))
                result = pipe(prompt=full_prompt, image=ref_pil,
                              num_inference_steps=20, guidance_scale=7.5)
            else:
                result = pipe(prompt=full_prompt, height=h, width=w,
                              num_inference_steps=20, guidance_scale=7.5)
        pil = result.images[0]
        import io as _io
        buf = _io.BytesIO()
        pil.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"

    return await asyncio.to_thread(_generate)


# ─── Public API ───────────────────────────────────────────────────────────────

async def generate_image(prompt: str, size: str,
                         settings: Optional[ClientSettings]) -> str:
    """Generate an image. Returns a data:image/png;base64,... URL."""
    image_cfg = settings.image if settings and settings.image else None
    system_prompt = image_cfg.systemPrompt if image_cfg else None
    reference_image = None
    if settings and settings.imageUseReference and settings.imageReferenceImage:
        reference_image = settings.imageReferenceImage

    mode = image_cfg.mode if image_cfg else "api"

    if mode == "local" and image_cfg and image_cfg.modelPath:
        try:
            return await _local_image(prompt, size, system_prompt,
                                      reference_image, image_cfg)
        except Exception as e:
            print(f"[Image] Local failed, falling back to ZAI API: {e}")
            # Fall through to online
            pass

    return await _zai_image(prompt, size, system_prompt, reference_image)
