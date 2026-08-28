"""Polymarket live venue via py-clob-client (Polygon). Positions read from the public data API."""
from __future__ import annotations

import time
from typing import Dict, List

import httpx
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import BalanceAllowanceParams, AssetType, OrderArgs
from py_clob_client.order_builder.constants import BUY, SELL

from ..config import Config
from ..models import AccountSnapshot, Action, ExecResult, PMPosition
from ..notify import log
from .base import Venue

CLOB = "https://clob.polymarket.com"
DATA_API = "https://data-api.polymarket.com"
CHAIN_ID = 137


class PolymarketVenue(Venue):
    name = "polymarket"

    def __init__(self, cfg: Config):
        self.cfg = cfg
        kwargs = dict(host=CLOB, key=cfg.poly_private_key, chain_id=CHAIN_ID)
        if cfg.poly_signature_type:
            kwargs.update(signature_type=cfg.poly_signature_type, funder=cfg.poly_funder)
        self.client = ClobClient(**kwargs)
        self.client.set_api_creds(self.client.create_or_derive_api_creds())
        self.addr = cfg.poly_funder or self.client.get_address()
        log.info(f"polymarket venue ready funder={self.addr[:10]}...")

    def _cash(self) -> float:
        try:
            bal = self.client.get_balance_allowance(BalanceAllowanceParams(asset_type=AssetType.COLLATERAL))
            return float(bal.get("balance", 0)) / 1e6
        except Exception as e:
            log.warning(f"polymarket balance: {e}")
            return 0.0

    def _positions(self) -> List[Dict]:
        try:
            r = httpx.get(f"{DATA_API}/positions", params={"user": self.addr, "sizeThreshold": 0.5}, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning(f"polymarket positions: {e}")
            return []

    def snapshot(self, prices: Dict[str, float]) -> AccountSnapshot:
        cash = self._cash()
        pm: List[PMPosition] = []
        for p in self._positions():
            tid = str(p.get("asset"))
            cur = prices.get(tid, float(p.get("curPrice") or 0))
            shares = float(p.get("size") or 0)
            pm.append(PMPosition(market_id=str(p.get("conditionId")), token_id=tid, question=p.get("title") or "",
                                 outcome=p.get("outcome") or "", shares=shares, avg_price=float(p.get("avgPrice") or 0),
                                 cur_price=cur, value_usd=shares * cur))
        equity = cash + sum(x.value_usd for x in pm)
        return AccountSnapshot(ts=time.time(), equity_usd=equity, available_usd=cash, pm=pm)

    def execute(self, a: Action, prices: Dict[str, float]) -> ExecResult:
        try:
            if a.kind == "pm_buy":
                shares = round(a.size_usd / a.limit_price, 2)
                if shares < 5:
                    return ExecResult(ok=False, detail="Polymarket minimum is ~5 shares")
                resp = self.client.create_and_post_order(OrderArgs(token_id=a.token_id, price=round(a.limit_price, 2), size=shares, side=BUY))
                ok = bool(resp and resp.get("success", True) and not resp.get("errorMsg"))
                return ExecResult(ok=ok, detail=f"PM buy {shares} @ {a.limit_price}: {resp}", raw={"order": resp, "fill_px": a.limit_price})
            if a.kind == "pm_sell":
                pos = next((p for p in self._positions() if str(p.get("asset")) == a.token_id), None)
                if not pos:
                    return ExecResult(ok=False, detail="no PM position for token")
                cur = prices.get(a.token_id, float(pos.get("curPrice") or 0.5))
                price = round(max(min(a.limit_price or cur * 0.98, 0.99), 0.01), 2)
                shares = float(pos["size"]) if not a.size_usd else min(float(pos["size"]), round(a.size_usd / price, 2))
                pnl_est = (price - float(pos.get("avgPrice") or 0)) * shares
                resp = self.client.create_and_post_order(OrderArgs(token_id=a.token_id, price=price, size=shares, side=SELL))
                ok = bool(resp and resp.get("success", True) and not resp.get("errorMsg"))
                return ExecResult(ok=ok, detail=f"PM sell {shares} @ {price}: {resp}", raw={"order": resp, "realized_pnl": pnl_est, "token_id": a.token_id})
            return ExecResult(ok=False, detail=f"polymarket venue cannot {a.kind}")
        except Exception as e:
            log.exception("polymarket execute")
            return ExecResult(ok=False, detail=f"exception: {e}")

    def flatten_all(self, prices: Dict[str, float]) -> List[ExecResult]:
        out = []
        for p in self._positions():
            tid = str(p.get("asset"))
            cur = prices.get(tid, float(p.get("curPrice") or 0.5))
            out.append(self.execute(Action(kind="pm_sell", token_id=tid, limit_price=max(cur * 0.95, 0.01)), prices))
        return out
