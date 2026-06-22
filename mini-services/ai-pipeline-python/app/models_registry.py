"""Local model registry: auto-scan + HuggingFace download.

Dynamically scans the HuggingFace cache directory (~/.cache/huggingface/hub/)
for downloaded models and classifies them into llm/asr/tts/image based on
file content heuristics.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional

from .config import HF_CACHE_DIR, SUGGESTED_LOCAL_MODELS

# ─── Scanning ─────────────────────────────────────────────────────────────────

def _scan_hf_cache() -> dict[str, list[str]]:
    """Scan the HF cache directory.

    HF cache layout: `~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<hash>/`
    Returns model paths (either repo_id or snapshot path for GGUF files).
    """
    out: dict[str, list[str]] = {"llm": [], "asr": [], "tts": [], "image": []}
    hub_root = HF_CACHE_DIR
    if not hub_root.exists():
        return out

    try:
        for entry in hub_root.iterdir():
            if not entry.is_dir() or not entry.name.startswith("models--"):
                continue
            parts = entry.name.split("--")
            if len(parts) < 3:
                continue
            org = parts[1]
            name = "--".join(parts[2:])
            repo_id = f"{org}/{name}"

            snap_dir = entry / "snapshots"
            if not snap_dir.exists():
                continue
            try:
                snaps = [d for d in snap_dir.iterdir() if d.is_dir()]
            except PermissionError:
                continue
            if not snaps:
                continue
            snap = None
            for s in snaps:
                try:
                    files = [f.name for f in s.iterdir() if f.is_file()]
                except PermissionError:
                    continue
                if files:
                    snap = s
                    break
            if snap is None:
                continue

            service = _classify_model_files(repo_id, files)
            if service and repo_id not in out[service]:
                gguf_files = [f for f in files if f.endswith(".gguf")]
                if gguf_files:
                    out[service].append(str(snap))
                else:
                    out[service].append(repo_id)
    except PermissionError:
        pass
    return out


def _scan_local_models_dir(models_dir: Path) -> dict[str, list[str]]:
    """Scan a project-local models directory (e.g. ./models/)."""
    out: dict[str, list[str]] = {"llm": [], "asr": [], "tts": [], "image": []}
    if not models_dir.exists():
        return out
    try:
        for entry in models_dir.iterdir():
            if not entry.is_dir():
                continue
            try:
                files = [f.name for f in entry.iterdir() if f.is_file()]
            except PermissionError:
                continue
            service = _classify_model_files(entry.name, files) or "llm"
            if entry.name not in out[service]:
                out[service].append(entry.name)
    except PermissionError:
        pass
    return out


def _classify_model_files(repo_id: str, files: list[str]) -> Optional[str]:
    """Heuristically classify a model directory into llm/asr/tts/image."""
    lower_id = repo_id.lower()
    fset = set(files)

    # Image / diffusion
    if "model_index.json" in fset:
        return "image"
    if any(k in lower_id for k in ("stable-diffusion", "flux", "kandinsky", "pixart")):
        return "image"

    # ASR
    if any(k in lower_id for k in ("whisper", "sensevoice", "paraformer", "wav2vec2")):
        return "asr"

    # TTS — keywords and file signatures
    tts_keywords = ("cosyvoice", "chattts", "vits", "bark", "gtts", "fun-cosyvoice",
                     "funasr", "speech", "tts", "omnivoice", "dots")
    tts_files = {"flow.pt", "flow.decoder.estimator.fp32.onnx", "hift.pt",
                 "speech_tokenizer_v3.onnx", "campplus.onnx", "llm.rl.pt"}
    if any(k in lower_id for k in tts_keywords):
        return "tts"
    if tts_files & fset:
        return "tts"

    # Check config.json for OmniVoice architecture
    if "config.json" in fset and "model.safetensors" in fset:
        try:
            for snap_dir in Path(f"./models/{repo_id}").rglob("config.json"):
                with open(snap_dir) as f:
                    cfg = json.load(f)
                if cfg.get("model_type") == "omnivoice" or "OmniVoice" in cfg.get("architectures", []):
                    return "tts"
                break
        except Exception:
            pass

    # LLM (default for text models with config.json)
    if "config.json" in fset:
        return "llm"
    return None


def list_local_models() -> dict[str, list[str]]:
    """Return a dict {llm, asr, tts, image} of locally-available model names."""
    out: dict[str, list[str]] = {"llm": [], "asr": [], "tts": [], "image": []}

    # 1. Project-local models dir
    try:
        local_dir = MODELS_DIR
    except NameError:
        local_dir = Path("./models")
    local_models = _scan_local_models_dir(local_dir)
    for service, names in local_models.items():
        for n in names:
            if n not in out[service]:
                out[service].append(n)

    # 2. HF cache (dedup, prefer org/name form)
    hf_models = _scan_hf_cache()
    for service, names in hf_models.items():
        for n in names:
            if n not in out[service]:
                out[service].append(n)

    return out


# ─── HuggingFace download ─────────────────────────────────────────────────────

async def download_model(
    model_name: str,
    service: str,
    sid: str,
    emit: EmitFn,
) -> bool:
    """Download a model from HuggingFace by repo id."""
    repo_id = model_name.strip()
    if repo_id.startswith("https://huggingface.co/"):
        repo_id = repo_id[len("https://huggingface.co/"):].rstrip("/")
    repo_id = re.sub(r"/(tree|blob)/[^/]+$", "", repo_id)

    if not repo_id or "/" not in repo_id:
        await emit("error", f"无效的模型名称：{model_name}（需为 org/name 格式）")
        return False

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        await emit("error", "huggingface_hub 未安装，无法下载模型")
        return False

    await emit("model_status", {"service": service, "status": "generating",
                                "message": f"正在下载 {repo_id} ..."})

    progress = {"done": False, "error": None}
    abort_flag = threading.Event()

    def _do_download():
        try:
            token = (
                os.environ.get("HF_HUB_TOKEN")
                or os.environ.get("HUGGING_FACE_HUB_TOKEN")
                or None
            )
            snapshot_download(repo_id=repo_id, token=token)
            if not abort_flag.is_set():
                progress["done"] = True
        except Exception as e:
            if not abort_flag.is_set():
                progress["error"] = str(e)

    t = threading.Thread(target=_do_download, daemon=True)
    t.start()

    elapsed = 0
    try:
        while t.is_alive():
            await asyncio.sleep(5)
            elapsed += 5
            await emit("download_progress", {
                "service": service, "modelName": repo_id, "elapsed": elapsed,
            })
    except asyncio.CancelledError:
        abort_flag.set()
        raise

    t.join(timeout=2)
    if progress["error"]:
        await emit("error", f"下载失败：{progress['error']}")
        await emit("model_status", {"service": service, "status": "ready"})
        return False
    if not progress["done"]:
        await emit("error", "下载未完成")
        await emit("model_status", {"service": service, "status": "ready"})
        return False

    await emit("model_downloaded", {"service": service, "modelName": repo_id})
    await emit("model_status", {"service": service, "status": "ready",
                                "message": f"{repo_id} 下载完成"})
    return True


def local_runtimes_available() -> dict[str, bool]:
    """Check which local-model runtimes are importable."""
    out = {"llm": False, "asr": False, "tts": False, "image": False}
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        out["llm"] = True
        out["asr"] = True
        out["tts"] = True
    except ImportError:
        pass
    try:
        import torch  # noqa: F401
        import diffusers  # noqa: F401
        out["image"] = True
    except ImportError:
        pass
    return out
