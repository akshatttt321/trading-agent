"""Paper venue: simulated fills against real prices. Covers perps, spot and prediction markets."""
from __future__ import annotations

import time
from typing import Dict, List

from ..config import Config
from ..models import AccountSnapshot, Action, ExecResult, PerpPosition, PMPosition, SpotBalance
from ..state import State
from .base import Venue

FEE = 0.00045        # overwritten from config.paper at construction
SLIP = 0.0008
PM_SLIP = 0.01       # per side on outcome tokens


class PaperVenue(Venue):
    name = "paper"

    def __init__(self, cfg: Config, state: State):
        global FEE, SLIP, PM_SLIP
        FEE, SLIP, PM_SLIP = cfg.paper.fee_bps / 1e4, cfg.paper.slippage_bps / 1e4, cfg.paper.pm_slippage_cents / 100
        self.cfg = cfg
        self.state = state
        self.p = state.paper_load() or {
            "cash": cfg.paper_starting_equity_usd,
            "perps": {},   # coin -> {size, entry_px, leverage, stop_px, tp_px}
            "spot": {},    # pair -> {amount, avg_px}
            "pm": {},      # token_id -> {market_id, question, outcome, shares, avg_price}
        }
        self._save()

    def _save(self) -> None:
        self.state.paper_save(self.p)

    # ------------------------------------------------------------------ snapshot
    def snapshot(self, prices: Dict[str, float]) -> AccountSnapshot:
        perps, spot, pm = [], [], []
        unreal = 0.0
        margin_used = 0.0
        for coin, pos in self.p["perps"].items():
            mark = prices.get(coin, pos["entry_px"])
            upnl = (mark - pos["entry_px"]) * pos["size"]
            notional = abs(pos["size"]) * mark
            unreal += upnl
            margin_used += notional / pos["leverage"]
            liq = pos["entry_px"] * (1 - 0.9 / pos["leverage"]) if pos["size"] > 0 else pos["entry_px"] * (1 + 0.9 / pos["leverage"])
            perps.append(PerpPosition(coin=coin, size=pos["size"], entry_px=pos["entry_px"], mark_px=mark, notional_usd=notional,
                                      unrealized_pnl=upnl, leverage=pos["leverage"], liquidation_px=liq,
                                      stop_px=pos.get("stop_px"), tp_px=pos.get("tp_px")))
        spot_val = 0.0
        for pair, b in self.p["spot"].items():
            px = prices.get(pair, b["avg_px"])
            v = b["amount"] * px
            spot_val += v
            spot.append(SpotBalance(coin=pair, amount=b["amount"], value_usd=v))
        pm_val = 0.0
        for tid, q in self.p["pm"].items():
            px = prices.get(tid, q["avg_price"])
            v = q["shares"] * px
            pm_val += v
            pm.append(PMPosition(market_id=q["market_id"], token_id=tid, question=q["question"], outcome=q["outcome"],
                                 shares=q["shares"], avg_price=q["avg_price"], cur_price=px, value_usd=v,
                                 stop_px=q.get("stop_px"), tp_px=q.get("tp_px"), ends=q.get("ends")))
        equity = self.p["cash"] + unreal + spot_val + pm_val
        available = max(self.p["cash"] - margin_used + min(unreal, 0), 0)
        return AccountSnapshot(ts=time.time(), equity_usd=equity, available_usd=available, perps=perps, spot=spot, pm=pm)

    # --------------------------------------------------------------- execution
    def execute(self, a: Action, prices: Dict[str, float]) -> ExecResult:
        try:
            fn = getattr(self, f"_do_{a.kind}")
        except AttributeError:
            return ExecResult(ok=False, detail=f"paper venue cannot {a.kind}")
        res = fn(a, prices)
        self._save()
        return res

    def _do_hold(self, a, prices):
        return ExecResult(ok=True, detail="hold")

    def _do_open_perp(self, a: Action, prices) -> ExecResult:
        px = prices.get(a.coin)
        if not px:
            return ExecResult(ok=False, detail=f"no price for {a.coin}")
        is_long = a.side == "long"
        if a.order_type == "limit" and a.limit_price:      # resting order triggered: maker fill exactly at the limit
            fill = a.limit_price
            fee = a.size_usd * (FEE / 3)                   # maker fee ~1/3 of taker
        else:
            fill = px * (1 + SLIP) if is_long else px * (1 - SLIP)
            fee = a.size_usd * FEE
        size = a.size_usd / fill * (1 if is_long else -1)
        pos = self.p["perps"].get(a.coin)
        if pos and (pos["size"] > 0) != is_long:
            return ExecResult(ok=False, detail="opposite position exists; close_perp first")
        if pos:
            new_size = pos["size"] + size
            pos["entry_px"] = (pos["entry_px"] * abs(pos["size"]) + fill * abs(size)) / abs(new_size)
            pos["size"] = new_size
            pos["leverage"] = a.leverage or pos["leverage"]
            pos["stop_px"] = a.stop_loss_px or pos.get("stop_px")
            pos["tp_px"] = a.take_profit_px or pos.get("tp_px")
        else:
            self.p["perps"][a.coin] = {"size": size, "entry_px": fill, "leverage": a.leverage or 1,
                                       "stop_px": a.stop_loss_px, "tp_px": a.take_profit_px, "opened": time.time(),
                                       "init_stop": a.stop_loss_px, "scaled": False}
        self.p["cash"] -= fee
        return ExecResult(ok=True, detail=f"paper fill {a.side} {abs(size):.5g} {a.coin} @ {fill:.6g} (fee ${fee:.2f})",
                          raw={"fill_px": fill, "size": size, "fee": fee})

    def _close_perp_at(self, coin: str, px: float, why: str) -> ExecResult:
        pos = self.p["perps"].pop(coin, None)
        if not pos:
            return ExecResult(ok=False, detail=f"no position in {coin}")
        is_long = pos["size"] > 0
        fill = px * (1 - SLIP) if is_long else px * (1 + SLIP)
        pnl = (fill - pos["entry_px"]) * pos["size"]
        fee = abs(pos["size"]) * fill * FEE
        self.p["cash"] += pnl - fee
        return ExecResult(ok=True, detail=f"paper close {coin} @ {fill:.6g} pnl ${pnl - fee:+.2f} ({why})",
                          raw={"realized_pnl": pnl - fee, "fill_px": fill, "coin": coin})

    def _do_close_perp(self, a: Action, prices) -> ExecResult:
        px = prices.get(a.coin)
        if not px:
            return ExecResult(ok=False, detail=f"no price for {a.coin}")
        return self._close_perp_at(a.coin, px, "agent close")

    def _do_update_stop(self, a: Action, prices) -> ExecResult:
        pos = self.p["perps"].get(a.coin)
        if not pos:
            return ExecResult(ok=False, detail=f"no position in {a.coin}")
        pos["stop_px"] = a.stop_loss_px
        if a.take_profit_px:
            pos["tp_px"] = a.take_profit_px
        return ExecResult(ok=True, detail=f"stop {a.coin} -> {a.stop_loss_px}")

    def _do_spot_buy(self, a: Action, prices) -> ExecResult:
        px = prices.get(a.coin)
        if not px:
            return ExecResult(ok=False, detail=f"no price for {a.coin}")
        fill = px * (1 + SLIP)
        amt = a.size_usd / fill
        cost = a.size_usd * (1 + FEE)
        if cost > self.p["cash"]:
            return ExecResult(ok=False, detail="insufficient cash")
        b = self.p["spot"].setdefault(a.coin, {"amount": 0.0, "avg_px": fill})
        b["avg_px"] = (b["avg_px"] * b["amount"] + fill * amt) / (b["amount"] + amt)
        b["amount"] += amt
        self.p["cash"] -= cost
        return ExecResult(ok=True, detail=f"paper spot buy {amt:.5g} {a.coin} @ {fill:.6g}", raw={"fill_px": fill})

    def _do_spot_sell(self, a: Action, prices) -> ExecResult:
        b = self.p["spot"].get(a.coin)
        px = prices.get(a.coin)
        if not b or not px:
            return ExecResult(ok=False, detail=f"no spot balance/price for {a.coin}")
        fill = px * (1 - SLIP)
        amt = min(b["amount"], (a.size_usd / fill) if a.size_usd else b["amount"])
        proceeds = amt * fill * (1 - FEE)
        pnl = (fill - b["avg_px"]) * amt
        b["amount"] -= amt
        if b["amount"] * fill < 1:
            self.p["spot"].pop(a.coin)
        self.p["cash"] += proceeds
        return ExecResult(ok=True, detail=f"paper spot sell {amt:.5g} {a.coin} @ {fill:.6g} pnl ${pnl:+.2f}",
                          raw={"realized_pnl": pnl, "coin": a.coin})

    def _do_pm_buy(self, a: Action, prices) -> ExecResult:
        cur = prices.get(a.token_id)
        if cur is None:
            return ExecResult(ok=False, detail="no price for token")
        if a.limit_price < cur:
            return ExecResult(ok=False, detail=f"limit {a.limit_price} below market {cur}: no fill")
        fill = min(cur + PM_SLIP, a.limit_price)
        shares = a.size_usd / fill
        if a.size_usd > self.p["cash"]:
            return ExecResult(ok=False, detail="insufficient cash")
        meta = (getattr(self, "pm_meta", {}) or {}).get(str(a.market_id)) or {}
        question = meta.get("question") or (getattr(self, "pm_questions", {}) or {}).get(str(a.market_id)) or f"market {a.market_id}"
        q = self.p["pm"].setdefault(a.token_id, {"market_id": a.market_id, "question": question, "outcome": a.outcome,
                                                 "shares": 0.0, "avg_price": fill, "ends": meta.get("ends")})
        q["avg_price"] = (q["avg_price"] * q["shares"] + fill * shares) / (q["shares"] + shares)
        q["shares"] += shares
        if a.stop_loss_px is not None: q["stop_px"] = a.stop_loss_px
        if a.take_profit_px is not None: q["tp_px"] = a.take_profit_px
        self.p["cash"] -= a.size_usd
        lv = f" stop {q.get('stop_px')} target {q.get('tp_px')}" if q.get("stop_px") or q.get("tp_px") else ""
        return ExecResult(ok=True, detail=f"paper PM buy {shares:.1f} '{a.outcome}' @ {fill:.3f}{lv}", raw={"fill_px": fill})

    def _do_pm_update(self, a: Action, prices) -> ExecResult:
        q = self.p["pm"].get(a.token_id)
        if not q:
            return ExecResult(ok=False, detail="no PM position for token")
        if a.stop_loss_px is not None: q["stop_px"] = a.stop_loss_px
        if a.take_profit_px is not None: q["tp_px"] = a.take_profit_px
        return ExecResult(ok=True, detail=f"PM '{q['outcome']}' levels -> stop {q.get('stop_px')} target {q.get('tp_px')}")

    def _do_pm_sell(self, a: Action, prices) -> ExecResult:
        q = self.p["pm"].get(a.token_id)
        cur = prices.get(a.token_id)
        if not q or cur is None:
            return ExecResult(ok=False, detail="no PM position/price")
        fill = max(cur - PM_SLIP, 0.001)
        shares = min(q["shares"], (a.size_usd / fill) if a.size_usd else q["shares"])
        proceeds = shares * fill
        pnl = (fill - q["avg_price"]) * shares
        q["shares"] -= shares
        if q["shares"] < 0.5:                          # credit the residual dust instead of vaporising it
            proceeds += q["shares"] * fill
            self.p["pm"].pop(a.token_id)
        self.p["cash"] += proceeds
        return ExecResult(ok=True, detail=f"paper PM sell {shares:.1f} '{q['outcome']}' @ {fill:.3f} pnl ${pnl:+.2f}",
                          raw={"realized_pnl": pnl, "token_id": a.token_id})

    # ------------------------------------------------------------ housekeeping
    def housekeeping(self, prices: Dict[str, float]) -> List[str]:
        """Trigger simulated stops / take-profits. Returns event strings; realized pnl embedded."""
        events: List[str] = []
        for coin in list(self.p["perps"].keys()):
            pos = self.p["perps"][coin]
            px = prices.get(coin)
            if not px:
                continue
            is_long = pos["size"] > 0
            sp, tp = pos.get("stop_px"), pos.get("tp_px")
            hit = None
            if sp and ((is_long and px <= sp) or (not is_long and px >= sp)):
                hit = ("STOP", sp)
            elif tp and ((is_long and px >= tp) or (not is_long and px <= tp)):
                hit = ("TAKE-PROFIT", tp)
            if hit:
                res = self._close_perp_at(coin, hit[1], f"{hit[0]} hit")
                events.append(f"{hit[0]} {coin}: {res.detail}|{res.raw['realized_pnl']:.4f}|{coin}")
        # scale-out: at +scale_out_r R close a fraction, stop to breakeven, let the rest run
        so_r, so_f = self.cfg.risk.scale_out_r, self.cfg.risk.scale_out_frac
        if so_r:
            for coin in list(self.p["perps"].keys()):
                pos = self.p["perps"][coin]
                px = prices.get(coin)
                init = pos.get("init_stop")
                if not px or pos.get("scaled") or not init:
                    continue
                risk0 = abs(pos["entry_px"] - init)
                if not risk0:
                    continue
                r_now = ((px - pos["entry_px"]) if pos["size"] > 0 else (pos["entry_px"] - px)) / risk0
                if r_now >= so_r:
                    part = pos["size"] * so_f
                    fill = px * (1 - SLIP) if pos["size"] > 0 else px * (1 + SLIP)
                    pnl = (fill - pos["entry_px"]) * part
                    fee = abs(part) * fill * FEE
                    pos["size"] -= part
                    pos["scaled"] = True
                    be = pos["entry_px"] * (1.002 if pos["size"] > 0 else 0.998)
                    pos["stop_px"] = max(pos.get("stop_px") or 0, be) if pos["size"] > 0 else min(pos.get("stop_px") or 1e18, be)
                    self.p["cash"] += pnl - fee
                    events.append(f"SCALE-OUT {coin}: closed {so_f*100:.0f}% at +{r_now:.1f}R (${pnl - fee:+.2f}), stop -> breakeven|{pnl - fee:.4f}|{coin}")
        # prediction markets (swing mode): token-price stop / target triggers
        for tid in list(self.p["pm"].keys()):
            q = self.p["pm"][tid]
            px = prices.get(tid)
            if px is None:
                continue
            hit = None
            if q.get("stop_px") and px <= q["stop_px"]:
                hit = ("PM STOP", q["stop_px"])
            elif q.get("tp_px") and px >= q["tp_px"]:
                hit = ("PM TARGET", q["tp_px"])
            if hit:
                res = self._do_pm_sell(Action(kind="pm_sell", token_id=tid, limit_price=hit[1]), {**prices, tid: hit[1]})
                if res.ok:
                    events.append(f"{hit[0]} '{q['outcome']}' @ {hit[1]:.3f}: {res.detail}|{res.raw['realized_pnl']:.4f}|{tid}")
        # prediction markets: settle at $1 / $0 once the market has resolved
        from ..market_data import hours_to, pm_final_price
        for tid in list(self.p["pm"].keys()):
            q = self.p["pm"][tid]
            ends = q.get("ends")
            if ends and hours_to(ends) > -0.5:          # not past resolution yet (30 min grace)
                continue
            if not ends and prices.get(tid) not in (None,) and not (prices.get(tid) >= 0.995 or prices.get(tid) <= 0.005):
                continue
            final = pm_final_price(q["market_id"], tid)
            if final is None:
                continue
            proceeds = q["shares"] * final
            pnl = (final - q["avg_price"]) * q["shares"]
            self.p["pm"].pop(tid)
            self.p["cash"] += proceeds
            events.append(f"PM RESOLVED '{q['outcome']}' -> {'WIN' if final >= 0.5 else 'LOSS'} ${pnl:+.2f} | {q['question'][:50]}|{pnl:.4f}|{tid}")
        if events:
            self._save()
        return events

    def flatten_all(self, prices: Dict[str, float]) -> List[ExecResult]:
        out = []
        for coin in list(self.p["perps"]):
            out.append(self._close_perp_at(coin, prices.get(coin, self.p["perps"][coin]["entry_px"]), "flatten"))
        for pair in list(self.p["spot"]):
            out.append(self._do_spot_sell(Action(kind="spot_sell", coin=pair), prices))
        for tid in list(self.p["pm"]):
            out.append(self._do_pm_sell(Action(kind="pm_sell", token_id=tid), prices))
        self._save()
        return out
