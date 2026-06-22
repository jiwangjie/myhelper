"""Audio helpers: base64 <-> bytes, PCM Int16 <-> Float32, WAV header."""
from __future__ import annotations

import base64
import io
import struct
from typing import Optional

import numpy as np


def base64_to_bytes(b64: str) -> bytes:
    """Decode base64 string (with optional data: prefix) to bytes."""
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)


def bytes_to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def pcm_int16_to_float32(pcm_int16: bytes) -> np.ndarray:
    """Convert raw little-endian Int16 PCM bytes to Float32 array [-1, 1]."""
    arr = np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32)
    return arr / 32768.0


def float32_to_pcm_int16(float32: np.ndarray) -> bytes:
    """Convert Float32 [-1, 1] to little-endian Int16 PCM bytes."""
    clipped = np.clip(float32, -1.0, 1.0)
    int16 = (clipped * 32767.0).astype(np.int16)
    return int16.tobytes()


def wav_bytes_from_pcm(pcm: bytes, sample_rate: int = 24000, channels: int = 1,
                       bits_per_sample: int = 16) -> bytes:
    """Wrap raw PCM bytes into a WAV container."""
    data_len = len(pcm)
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_len, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align,
        bits_per_sample, b"data", data_len,
    )
    return header + pcm


def pcm_to_wav_base64(pcm_b64: str, sample_rate: int = 24000) -> str:
    """Take base64 PCM, wrap in WAV, return base64 WAV."""
    pcm = base64_to_bytes(pcm_b64)
    wav = wav_bytes_from_pcm(pcm, sample_rate=sample_rate)
    return bytes_to_base64(wav)


def mp3_to_pcm(mp3: bytes, target_sample_rate: int = 24000) -> tuple[bytes, int]:
    """Decode MP3 bytes to Int16 PCM at target_sample_rate.

    Uses librosa (already a project dep). Returns (pcm_bytes, sample_rate).
    """
    import librosa  # lazy import (heavy)
    audio, sr = librosa.load(io.BytesIO(mp3), sr=target_sample_rate, mono=True)
    pcm = float32_to_pcm_int16(audio.astype(np.float32))
    return pcm, target_sample_rate


def resample_pcm(pcm_int16: bytes, src_sr: int, dst_sr: int) -> bytes:
    """Resample Int16 PCM from src_sr to dst_sr, returning Int16 bytes."""
    if src_sr == dst_sr:
        return pcm_int16
    import librosa
    # Read Int16 PCM as float32 via numpy
    f32 = pcm_int16_to_float32(pcm_int16)
    resampled = librosa.resample(f32, orig_sr=src_sr, target_sr=dst_sr)
    return float32_to_pcm_int16(resampled)
