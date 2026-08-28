from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ActionKind = Literal[
    "hold",
    "open_perp",      # open or add to a perp position
    "close_perp",     # fully close a perp position
    "update_stop",    # move the stop-loss on an existing perp
    "spot_buy",
    "spot_sell",
    "pm_buy",         # buy an outcome token on a prediction market (optionally with stop_loss_px / take_profit_px on the TOKEN price)
    "pm_sell",        # sell an outcome token we hold
    "pm_update",      # set / move stop & target levels on a held outcome token
]


class Action(BaseModel):
    kind: ActionKind
    # perps / spot
    coin: Optional[str] = Field(None, description="Perp coin e.g. BTC, or spot pair e.g. HYPE/USDC")
    side: Optional[Literal["long", "short"]] = None
    size_usd: Optional[float] = Field(None, description="Notional in USD")
    leverage: Optional[int] = None
    stop_loss_px: Optional[float] = None
    take_profit_px: Optional[float] = None
    # prediction markets
    market_id: Optional[str] = None
    token_id: Optional[str] = None
    outcome: Optional[str] = None
    limit_price: Optional[float] = Field(None, description="PM price in 0-1, or perp limit price when order_type='limit'")
    order_type: Optional[Literal["market", "limit"]] = None   # open_perp only; None = market
    # always
    reason: str = ""
    confidence: float = Field(0.5, ge=0, le=1)


class WatchLevel(BaseModel):
    coin: str
    direction: str = "above"      # above | below
    px: float
    note: str = ""


class Decision(BaseModel):
    market_view: str = ""
    actions: List[Action] = Field(default_factory=list)
    notes: str = ""
    watch_levels: List[WatchLevel] = Field(default_factory=list)   # one-shot price alarms the 30s sensor watches


class PerpPosition(BaseModel):
    coin: str
    size: float           # signed; +long / -short
    entry_px: float
    mark_px: float
    notional_usd: float
    unrealized_pnl: float
    leverage: float
    liquidation_px: Optional[float] = None
    stop_px: Optional[float] = None
    tp_px: Optional[float] = None


class SpotBalance(BaseModel):
    coin: str
    amount: float
    value_usd: float


class PMPosition(BaseModel):
    market_id: str
    token_id: str
    question: str
    outcome: str
    shares: float
    avg_price: float
    cur_price: float
    value_usd: float
    stop_px: Optional[float] = None    # token-price stop (swing mode)
    tp_px: Optional[float] = None      # token-price target (swing mode)
    ends: Optional[str] = None


class AccountSnapshot(BaseModel):
    ts: float
    equity_usd: float
    available_usd: float
    perps: List[PerpPosition] = Field(default_factory=list)
    spot: List[SpotBalance] = Field(default_factory=list)
    pm: List[PMPosition] = Field(default_factory=list)

    @property
    def gross_exposure_usd(self) -> float:
        return sum(abs(p.notional_usd) for p in self.perps) + sum(s.value_usd for s in self.spot if s.coin != "USDC") + sum(p.value_usd for p in self.pm)

    @property
    def open_position_count(self) -> int:
        return len(self.perps) + len([s for s in self.spot if s.coin != "USDC" and s.value_usd > 1]) + len(self.pm)

    def pm_total_usd(self) -> float:
        return sum(p.value_usd for p in self.pm)


class ExecResult(BaseModel):
    ok: bool
    detail: str = ""
    raw: Optional[Dict] = None
