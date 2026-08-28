from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Dict, List

from ..models import AccountSnapshot, Action, ExecResult


class Venue(ABC):
    """A venue combines account state + execution for one or more products."""

    name: str = "venue"

    @abstractmethod
    def snapshot(self, prices: Dict[str, float]) -> AccountSnapshot: ...

    @abstractmethod
    def execute(self, a: Action, prices: Dict[str, float]) -> ExecResult: ...

    @abstractmethod
    def flatten_all(self, prices: Dict[str, float]) -> List[ExecResult]: ...

    def housekeeping(self, prices: Dict[str, float]) -> List[str]:
        """Per-cycle maintenance (e.g. paper stop-loss processing). Returns event strings."""
        return []


def merge_snapshots(ts: float, snaps: List[AccountSnapshot]) -> AccountSnapshot:
    out = AccountSnapshot(ts=ts, equity_usd=0, available_usd=0)
    for s in snaps:
        out.equity_usd += s.equity_usd
        out.available_usd += s.available_usd
        out.perps += s.perps
        out.spot += s.spot
        out.pm += s.pm
    return out
