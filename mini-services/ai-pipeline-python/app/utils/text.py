"""Text processing utilities: sentence splitting, action tag extraction."""
from __future__ import annotations

import re

_ACTION_RE = re.compile(r"<action>(.*?)</action>", re.DOTALL)
_SENTENCE_RE = re.compile(r"([^。！？.!?\n]+[。！？.!?\n]*)", re.DOTALL)


def split_into_sentences(text: str) -> list[str]:
    """Split text into sentences by CJK + ASCII punctuation and newlines."""
    if not text:
        return []
    parts = [m.group(0) for m in _SENTENCE_RE.finditer(text) if m.group(0)]
    if not parts:
        parts = [text]
    return parts


def extract_actions(text: str) -> list[str]:
    """Extract all <action>...</action> contents from text."""
    return [m.group(1).strip() for m in _ACTION_RE.finditer(text) if m.group(1).strip()]


def strip_actions(text: str) -> str:
    """Remove all <action>...</action> tags and trim."""
    return _ACTION_RE.sub("", text).strip()
