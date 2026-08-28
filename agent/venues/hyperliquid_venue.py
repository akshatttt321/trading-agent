"""Hyperliquid live/testnet venue: perps + spot via the official SDK, signed with an API wallet."""
from __future__ import annotations

import math
import time
from typing import Dict, List, Optional

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants

from ..config import Config
from ..market_data import MarketData
from ..models import AccountSnapshot, Action, ExecResult, PerpPosition, SpotBalance
from ..notify import log
from .base import Venue


def round_px(px: float, sz_decimals: int, is_spot: bool = False) -> float:
    """Hyperliquid: max 5 significant figures AND max (6 - szDecimals) decimals for perps, (8 - szDecimals) for spot."""
    if px <= 0:
        return px
    max_dec = (8 if is_spot else 6) - sz_decimals
    sig = round(px, 5 - int(math.floor(math.log10(abs(px)))) - 1)
    return round(sig, max(max_dec, 0))


def round_sz(sz: float, sz_decimals: int) -> float:
    return math.floor(sz * 10**sz_decimals) / 10**sz_decimals


class HyperliquidVenue(Venue):
    name = "hyperliquid"

    def __init__(self, cfg: Config, md: MarketData):
        self.cfg = cfg
        self.md = md
        url = constants.TESTNET_API_URL if cfg.mode == "testnet" else constants.MAINNET_API_URL
        wallet = Account.from_key(cfg.hl_api_wallet_key)
        self.addr = cfg.hl_account_address
        self.info = Info(url, skip_ws=True)
        self.ex = Exchange(wallet, url, account_address=self.addr)
        log.info(f"hyperliquid venue ready ({cfg.mode}) api_wallet={wallet.address[:10]}... account={self.addr[:10]}...")

    # ------------------------------------------------------------------ helpers
    def _sz_dec(self, name: str) -> int:
        if not self.md.sz_decimals:
            self.md.perp_overview()
            self.md.spot_overview()
        return self.md.sz_decimals.get(name, 3)

    def _trigger_orders(self) -> Dict[str, Dict[str, Dict]]:
        """coin -> {'sl': order, 'tp': order} from open trigger orders."""
        out: Dict[str, Dict[str, Dict]] = {}
        try:
            for o in self.info.frontend_open_orders(self.addr):
                if not o.get("isTrigger"):
                    continue
                kind = "tp" if "Take Profit" in (o.get("orderType") or "") else "sl"
                out.setdefault(o["coin"], {})[kind] = o
        except Exception as e:
            log.warning(f"open orders: {e}")
        return out

    @staticmethod
    def _status_ok(resp) -> (bool, str):
        try:
            if resp.get("status") != "ok":
                return False, str(resp)
            statuses = resp["response"]["data"]["statuses"]
            for s in statuses:
                if "error" in s:
                    return False, s["error"]
            return True, str(statuses)
        except Exception:
            return False, str(resp)

    # ----------------------------------------------------------------- snapshot
    def snapshot(self, prices: Dict[str, float]) -> AccountSnapshot:
        us = self.info.user_state(self.addr)
        ms = us["marginSummary"]
        equity = float(ms["accountValue"])
        available = float(us.get("withdrawable", 0))
        trig = self._trigger_orders()
        perps: List[PerpPosition] = []
        for ap in us.get("assetPositions", []):
            p = ap["position"]
            szi = float(p["szi"])
            if szi == 0:
                continue
            coin = p["coin"]
            mark = prices.get(coin) or float(p.get("entryPx") or 0)
            t = trig.get(coin, {})
            perps.append(PerpPosition(
                coin=coin, size=szi, entry_px=float(p.get("entryPx") or 0), mark_px=mark,
                notional_usd=abs(float(p["positionValue"])), unrealized_pnl=float(p["unrealizedPnl"]),
                leverage=float(p["leverage"]["value"]), liquidation_px=float(p["liquidationPx"]) if p.get("liquidationPx") else None,
                stop_px=float(t["sl"]["triggerPx"]) if "sl" in t else None,
                tp_px=float(t["tp"]["triggerPx"]) if "tp" in t else None,
            ))
        spot: List[SpotBalance] = []
        try:
            for b in self.info.spot_user_state(self.addr).get("balances", []):
                total = float(b["total"])
                if total <= 0:
                    continue
                if b["coin"] == "USDC":
                    equity += total
                    available += total
                    spot.append(SpotBalance(coin="USDC", amount=total, value_usd=total))
                else:
                    pair = f"{b['coin']}/USDC"
                    px = prices.get(pair) or 0
                    v = total * px
                    equity += v
                    spot.append(SpotBalance(coin=pair, amount=total, value_usd=v))
        except Exception as e:
            log.warning(f"spot state: {e}")
        return AccountSnapshot(ts=time.time(), equity_usd=equity, available_usd=available, perps=perps, spot=spot)

    # ---------------------------------------------------------------- execution
    def execute(self, a: Action, prices: Dict[str, float]) -> ExecResult:
        try:
            if a.kind == "open_perp":
                return self._open_perp(a, prices)
            if a.kind == "close_perp":
                return self._close_perp(a.coin, prices)
            if a.kind == "update_stop":
                return self._update_stop(a, prices)
            if a.kind in ("spot_buy", "spot_sell"):
                return self._spot(a, prices)
            return ExecResult(ok=False, detail=f"hyperliquid venue cannot {a.kind}")
        except Exception as e:
            log.exception("hyperliquid execute")
            return ExecResult(ok=False, detail=f"exception: {e}")

    def _place_trigger(self, coin: str, is_buy_close: bool, sz: float, px: float, tpsl: str) -> ExecResult:
        pxr = round_px(px, self._sz_dec(coin))
        resp = self.ex.order(coin, is_buy_close, sz, pxr,
                             {"trigger": {"triggerPx": pxr, "isMarket": True, "tpsl": tpsl}}, reduce_only=True)
        ok, det = self._status_ok(resp)
        return ExecResult(ok=ok, detail=f"{tpsl} @ {pxr}: {det}", raw=resp)

    def _open_perp(self, a: Action, prices) -> ExecResult:
        px = prices.get(a.coin)
        if not px:
            return ExecResult(ok=False, detail=f"no price for {a.coin}")
        is_buy = a.side == "long"
        dec = self._sz_dec(a.coin)
        sz = round_sz(a.size_usd / px, dec)
        if sz <= 0:
            return ExecResult(ok=False, detail=f"size rounds to 0 for {a.coin} (szDecimals={dec})")
        self.ex.update_leverage(int(a.leverage or 1), a.coin, is_cross=True)
        resp = self.ex.market_open(a.coin, is_buy, sz, None, 0.01)
        ok, det = self._status_ok(resp)
        if not ok:
            return ExecResult(ok=False, detail=f"market_open failed: {det}", raw=resp)
        # figure out filled size from response
        filled_sz = sz
        try:
            f = resp["response"]["data"]["statuses"][0].get("filled")
            if f:
                filled_sz = float(f["totalSz"])
                px = float(f["avgPx"])
        except Exception:
            pass
        # protective orders - if the stop cannot be placed, close immediately (never naked)
        for c in list(self._trigger_orders().get(a.coin, {}).values()):  # clear stale triggers
            try:
                self.ex.cancel(a.coin, c["oid"])
            except Exception:
                pass
        # trigger orders should cover the whole position, not just this fill
        total_sz = filled_sz
        try:
            for ap in self.info.user_state(self.addr)["assetPositions"]:
                if ap["position"]["coin"] == a.coin:
                    total_sz = abs(float(ap["position"]["szi"]))
        except Exception:
            pass
        sl = self._place_trigger(a.coin, not is_buy, total_sz, a.stop_loss_px, "sl") if a.stop_loss_px else ExecResult(ok=True, detail="no sl")
        if not sl.ok and self.cfg.risk.require_stop_loss:
            self.ex.market_close(a.coin)
            return ExecResult(ok=False, detail=f"filled but STOP FAILED ({sl.detail}) -> position closed immediately", raw=resp)
        tp = self._place_trigger(a.coin, not is_buy, total_sz, a.take_profit_px, "tp") if a.take_profit_px else ExecResult(ok=True, detail="no tp")
        return ExecResult(ok=True, detail=f"filled {a.side} {filled_sz} {a.coin} @ ~{px}; {sl.detail}; {tp.detail}",
                          raw={"fill_px": px, "size": filled_sz, "order": resp})

    def _close_perp(self, coin: str, prices) -> ExecResult:
        # realized pnl estimate from current unrealized (fills API is authoritative; good enough for the learner)
        upnl = 0.0
        for ap in self.info.user_state(self.addr)["assetPositions"]:
            if ap["position"]["coin"] == coin:
                upnl = float(ap["position"]["unrealizedPnl"])
        for o in self._trigger_orders().get(coin, {}).values():
            try:
                self.ex.cancel(coin, o["oid"])
            except Exception as e:
                log.warning(f"cancel {coin} {o.get('oid')}: {e}")
        resp = self.ex.market_close(coin)
        if resp is None:
            return ExecResult(ok=False, detail=f"no position in {coin}")
        ok, det = self._status_ok(resp)
        return ExecResult(ok=ok, detail=f"close {coin}: {det}", raw={"realized_pnl": upnl, "coin": coin, "order": resp})

    def _update_stop(self, a: Action, prices) -> ExecResult:
        pos = None
        for ap in self.info.user_state(self.addr)["assetPositions"]:
            if ap["position"]["coin"] == a.coin:
                pos = ap["position"]
        if not pos:
            return ExecResult(ok=False, detail=f"no position in {a.coin}")
        szi = float(pos["szi"])
        trig = self._trigger_orders().get(a.coin, {})
        if "sl" in trig:
            self.ex.cancel(a.coin, trig["sl"]["oid"])
        res = self._place_trigger(a.coin, szi < 0, abs(szi), a.stop_loss_px, "sl")
        if a.take_profit_px:
            if "tp" in trig:
                self.ex.cancel(a.coin, trig["tp"]["oid"])
            tp = self._place_trigger(a.coin, szi < 0, abs(szi), a.take_profit_px, "tp")
            res.detail += "; " + tp.detail
        return res

    def _spot(self, a: Action, prices) -> ExecResult:
        px = prices.get(a.coin)
        if not px:
            return ExecResult(ok=False, detail=f"no price for {a.coin}")
        name = self.md.spot_internal_name(a.coin)
        dec = self._sz_dec(name)
        is_buy = a.kind == "spot_buy"
        if is_buy:
            sz = round_sz(a.size_usd / px, dec)
        else:
            held = 0.0
            base = a.coin.split("/")[0]
            for b in self.info.spot_user_state(self.addr).get("balances", []):
                if b["coin"] == base:
                    held = float(b["total"])
            sz = round_sz(min(held, a.size_usd / px) if a.size_usd else held, dec)
        if sz <= 0:
            return ExecResult(ok=False, detail="spot size rounds to 0")
        resp = self.ex.market_open(name, is_buy, sz, None, 0.01)
        ok, det = self._status_ok(resp)
        return ExecResult(ok=ok, detail=f"spot {'buy' if is_buy else 'sell'} {sz} {a.coin}: {det}", raw={"order": resp, "coin": a.coin})

    def flatten_all(self, prices: Dict[str, float]) -> List[ExecResult]:
        out: List[ExecResult] = []
        try:
            for o in self.info.open_orders(self.addr):
                try:
                    self.ex.cancel(o["coin"], o["oid"])
                except Exception as e:
                    out.append(ExecResult(ok=False, detail=f"cancel {o['coin']}: {e}"))
        except Exception as e:
            out.append(ExecResult(ok=False, detail=f"list orders: {e}"))
        for ap in self.info.user_state(self.addr).get("assetPositions", []):
            coin = ap["position"]["coin"]
            if float(ap["position"]["szi"]) != 0:
                out.append(self._close_perp(coin, prices))
        try:
            for b in self.info.spot_user_state(self.addr).get("balances", []):
                if b["coin"] != "USDC" and float(b["total"]) > 0:
                    out.append(self._spot(Action(kind="spot_sell", coin=f"{b['coin']}/USDC"), prices))
        except Exception as e:
            out.append(ExecResult(ok=False, detail=f"spot flatten: {e}"))
        return out
