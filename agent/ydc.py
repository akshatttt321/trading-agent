"""Thin You.com API client. Optional everywhere: callers fall back to Gemini grounding when YDC_API_KEY is absent.
Used for (a) independent second-source verification of prediction-market research and (b) the twice-daily market brief."""
from __future__ import annotations

import os
from typing import Dict, Optional

import requests

from .notify import log

BASE = "https://api.you.com/v1"


def key() -> Optional[str]:
    return os.environ.get("YDC_API_KEY") or None


def _post(path: str, payload: Dict, timeout: int) -> Optional[Dict]:
    k = key()
    if not k:
        return None
    try:
        r = requests.post(f"{BASE}/{path}", json=payload,
                          headers={"X-API-Key": k, "Content-Type": "application/json"}, timeout=timeout)
        if r.status_code != 200:
            log.warning(f"ydc {path}: HTTP {r.status_code} {r.text[:120]}")
            return None
        return r.json()
    except Exception as e:
        log.warning(f"ydc {path}: {e}")
        return None


def answer(query: str, timeout: int = 25) -> Optional[Dict]:
    """Grounded answer with citations: {'answer': str, 'citations': [...]}. ~4s typical."""
    return _post("answer", {"query": query}, timeout)


def finance_research(inp: str, effort: str = "standard", timeout: int = 90) -> Optional[str]:
    """Deep finance research; returns markdown content or None. ~30s at standard effort."""
    d = _post("finance_research", {"input": inp, "research_effort": effort}, timeout)
    return ((d or {}).get("output") or {}).get("content")
