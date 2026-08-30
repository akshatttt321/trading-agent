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
        self.agent_state = None                      # injected by the agent (setattr) - persists levels/cursors
        log.info(f"polymarket venue ready funder={self.addr[:10]}...")

    # ---- protective levels (token-price stop/target), persisted in the journal so restarts keep protection ----
    def _levels(self) -> Dict:
        return (self.agent_state.get("live_pm_levels") if self.agent_state else None) or {}

    def _save_levels(self, lv: Dict) -> None:
        if self.agent_state:
            self.agent_state.set("live_pm_levels", lv)

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
                if not ok:
                    return ExecResult(ok=False, detail=f"PM buy rejected: {resp}", raw={"order": resp})
                # FILL CONFIRMATION: poll briefly; an unmatched maker order is canceled so 'ok' always means 'filled'
                oid = (resp or {}).get("orderID") or (resp or {}).get("orderId")
                matched = None
                if oid:
                    for _ in range(4):
                        time.sleep(2)
                        try:
                            o = self.client.get_order(oid)
                            matched = float(o.get("size_matched") or o.get("sizeMatched") or 0)
                            if matched and matched >= shares * 0.95:
                                break
                        except Exception as e:
                            log.warning(f"pm order poll: {e}")
                    if matched is not None and matched < shares * 0.05:
                        try:
                            self.client.cancel(oid)
                        except Exception:
                            pass
                        return ExecResult(ok=False, detail=f"PM buy not filled at {a.limit_price} (no liquidity) - canceled", raw={"order": resp})
                got = matched if matched else shares
                return ExecResult(ok=True, detail=f"PM buy filled {got}/{shares} @ {a.limit_price}", raw={"order": resp, "fill_px": a.limit_price})
            if a.kind == "pm_update":
                pos = next((p for p in self._positions() if str(p.get("asset")) == a.token_id), None)
                if not pos:
                    return ExecResult(ok=False, detail="no PM position for token")
                lv = self._levels()
                cur = lv.get(a.token_id, {})
                if a.stop_loss_px is not None:
                    cur["stop"] = float(a.stop_loss_px)
                if a.take_profit_px is not None:
                    cur["tp"] = float(a.take_profit_px)
                lv[a.token_id] = cur
                self._save_levels(lv)
                return ExecResult(ok=True, detail=f"PM levels set: stop {cur.get('stop')} target {cur.get('tp')} (agent-held, executed by housekeeping)")
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

    def housekeeping(self, prices: Dict[str, float]) -> List[str]:
        """Agent-held stop/target execution + resolution detection for live PM positions (mirrors the paper venue).
        Event format matches the agent's parser: 'TEXT|pnl|token_id'."""
        events: List[str] = []
        if not self.agent_state:
            return events
        lv = self._levels()
        seen_res = self.agent_state.get("pm_resolved_seen") or []
        changed = False
        for pos in self._positions():
            tid = str(pos.get("asset"))
            cur = prices.get(tid, float(pos.get("curPrice") or 0))
            shares = float(pos.get("size") or 0)
            avg = float(pos.get("avgPrice") or 0)
            if not cur or shares <= 0:
                continue
            if (cur >= 0.995 or cur <= 0.005) and tid not in seen_res:      # resolved (or pinned): CLOB selling is over
                pnl = (round(cur) - avg) * shares
                events.append(f"PM resolved '{pos.get('outcome')}' ~{cur:.3f} - redeem on polymarket.com|{pnl:.4f}|{tid}")
                seen_res.append(tid)
                lv.pop(tid, None)
                changed = True
                continue
            l = lv.get(tid) or {}
            hit_stop = l.get("stop") is not None and cur <= l["stop"]
            hit_tp = l.get("tp") is not None and cur >= l["tp"]
            if hit_stop or hit_tp:
                price = round(max(min(cur * 0.97, 0.99), 0.01), 2)
                res = self.execute(Action(kind="pm_sell", token_id=tid, limit_price=price), prices)
                if res.ok:
                    pnl = (price - avg) * shares
                    tag = "PM STOP" if hit_stop else "PM TARGET"
                    events.append(f"{tag} '{pos.get('outcome')}' @ {price} (level {l.get('stop') if hit_stop else l.get('tp')})|{pnl:.4f}|{tid}")
                    lv.pop(tid, None)
                    changed = True
                else:
                    log.warning(f"PM level hit but sell failed for {tid}: {res.detail}")
        if changed:
            self._save_levels(lv)
            self.agent_state.set("pm_resolved_seen", seen_res[-100:])
        return events

    def flatten_all(self, prices: Dict[str, float]) -> List[ExecResult]:
        out = []
        for p in self._positions():
            tid = str(p.get("asset"))
            cur = prices.get(tid, float(p.get("curPrice") or 0.5))
            out.append(self.execute(Action(kind="pm_sell", token_id=tid, limit_price=max(cur * 0.95, 0.01)), prices))
        return out
