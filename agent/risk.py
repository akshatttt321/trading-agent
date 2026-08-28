"""
Deterministic risk gate. The LLM proposes actions; this module approves, clamps,
or rejects them. Nothing here reads LLM output as instructions - only as data.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional, Tuple

from .config import Config, KILL_FILE
from .models import AccountSnapshot, Action
from .state import State

RISK_REDUCING = {"close_perp", "update_stop", "spot_sell", "pm_sell", "pm_update", "hold"}


def trend_strength(market: Optional[dict], side: str) -> Tuple[int, str]:
    """0..4 strength of the market-wide trend in `side` direction, from free indicator data."""
    if not market:
        return 0, "no market data"
    perps = market.get("perps", {}) or {}
    want = side == "long"
    agree = [c for c, v in perps.items() if v.get("ema20_above_ema50") is want and bool(v.get("above_sma50_1h")) is want]
    frac = len(agree) / len(perps) if perps else 0
    btc = perps.get("BTC", {})
    btc_regime = (btc.get("ema20_above_ema50") is want and bool(btc.get("above_sma50_1h")) is want)
    chg = btc.get("chg_24h_pct") or 0
    btc_mom = chg > 2 if want else chg < -2
    score = int(frac >= 0.5) + int(frac >= 0.75) + int(btc_regime) + int(btc_mom)
    return score, f"breadth {frac*100:.0f}% ({len(agree)}/{len(perps)}), BTC regime {'agrees' if btc_regime else 'no'}, BTC 24h {chg:+.1f}%"


@dataclass
class Verdict:
    approved: bool
    reason: str
    action: Action  # possibly clamped


class RiskGate:
    def __init__(self, cfg: Config, state: State):
        self.cfg = cfg
        self.r = cfg.risk
        self.state = state

    # ------------------------------------------------------------------ account
    def check_kill(self, snap: AccountSnapshot) -> Optional[str]:
        """Returns a reason string if the whole agent must flatten and stop."""
        if KILL_FILE.exists():
            return f"manual kill switch present: {KILL_FILE}"
        start = self.state.get("starting_equity")
        if start:
            dd = (start - snap.equity_usd) / start * 100
            if dd >= self.r.max_drawdown_pct:
                return f"max drawdown hit: {dd:.1f}% >= {self.r.max_drawdown_pct}% (start ${start:,.2f}, now ${snap.equity_usd:,.2f})"
        if snap.equity_usd < self.r.min_equity_usd:
            return f"equity ${snap.equity_usd:.2f} below minimum ${self.r.min_equity_usd}"
        return None

    def roll_day(self, snap: AccountSnapshot) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if self.state.get("day") != today:
            prev_start = self.state.get("day_start_equity")
            if prev_start is not None:
                self.state.set("prev_day_pnl", round(snap.equity_usd - prev_start, 4))
            self.state.set("day", today)
            self.state.set("day_start_equity", snap.equity_usd)
            self.state.set("daily_halt", False)

    def daily_halted(self, snap: AccountSnapshot) -> Tuple[bool, str]:
        if self.state.get("daily_halt"):
            return True, "daily loss limit already hit today"
        ds = self.state.get("day_start_equity") or snap.equity_usd
        loss_pct = (ds - snap.equity_usd) / ds * 100 if ds else 0
        if loss_pct >= self.r.max_daily_loss_pct:
            self.state.set("daily_halt", True)
            return True, f"daily loss {loss_pct:.1f}% >= {self.r.max_daily_loss_pct}%"
        return False, ""

    # ------------------------------------------------------------------- action
    def evaluate(self, a: Action, snap: AccountSnapshot, cycle_start_ts: float = 0.0, funding: Optional[dict] = None, regime: str = "", market: Optional[dict] = None) -> Verdict:
        """cycle_start_ts: orders placed in the current cycle are exempt from the inter-order cooldown
        (a single decision may legitimately contain several actions); the hourly cap still counts them."""
        a = a.model_copy(deep=True)
        eq = snap.equity_usd

        if a.kind == "hold":
            return Verdict(True, "hold", a)

        # Risk-reducing actions are always allowed (closing, tightening stops).
        if a.kind in RISK_REDUCING:
            if a.kind == "update_stop":
                pos = next((p for p in snap.perps if p.coin == a.coin), None)
                if not pos:
                    return Verdict(False, f"no open position in {a.coin}", a)
                if a.stop_loss_px is None:
                    return Verdict(False, "update_stop needs stop_loss_px", a)
                if not self._stop_is_protective(pos.size > 0, pos.mark_px, a.stop_loss_px):
                    return Verdict(False, "stop must be below mark for longs / above for shorts", a)
                # only apply the trailing/noise guard when the stop is actually being TIGHTENED (moved closer to mark
                # than where it already is). Re-sending the same stop, or only changing the target, is not a tighten.
                is_long = pos.size > 0
                cur_stop = pos.stop_px
                new_stop = a.stop_loss_px
                eps = pos.mark_px * 1e-4
                if cur_stop is not None:
                    looser = (new_stop < cur_stop - eps) if is_long else (new_stop > cur_stop + eps)
                    tighter = (new_stop > cur_stop + eps) if is_long else (new_stop < cur_stop - eps)
                    if looser:
                        return Verdict(False, f"would widen the stop {cur_stop}->{new_stop} - never loosen a stop", a)
                    if not tighter:
                        return Verdict(True, "risk-reducing (stop unchanged / target adjust)", a)   # no-op on stop: allow
                # trailing guard: don't suffocate a trend position with a stop inside normal noise
                atr_pct = ((market or {}).get("perps", {}).get(a.coin) or {}).get("atr14_1h_pct")
                min_dist_pct = max((atr_pct or 0) * self.r.min_stop_atr_mult, self.r.min_stop_pct)
                dist_pct = abs(pos.mark_px - a.stop_loss_px) / pos.mark_px * 100
                if dist_pct < min_dist_pct:
                    init_risk = abs(pos.entry_px - (pos.stop_px or pos.entry_px)) or (pos.entry_px * self.r.max_stop_distance_pct / 100)
                    r_now = ((pos.mark_px - pos.entry_px) if pos.size > 0 else (pos.entry_px - pos.mark_px)) / init_risk if init_risk else 0
                    at_or_beyond_be = (a.stop_loss_px >= pos.entry_px) if pos.size > 0 else (a.stop_loss_px <= pos.entry_px)
                    if not (r_now >= self.r.breakeven_after_r and at_or_beyond_be):
                        return Verdict(False, f"stop {dist_pct:.2f}% from mark is inside noise (min {min_dist_pct:.2f}% = max({self.r.min_stop_atr_mult}x ATR {atr_pct or 0:.2f}%, {self.r.min_stop_pct}%)); "
                                              f"position is {r_now:+.1f}R - tighten only once >= {self.r.breakeven_after_r}R", a)
                # trailing TAKE-PROFIT: extending the target is allowed only on a protected trade (>= +1R and stop at/beyond entry)
                if a.take_profit_px is not None and pos.tp_px is not None:
                    long = pos.size > 0
                    extending = a.take_profit_px > pos.tp_px if long else a.take_profit_px < pos.tp_px
                    if extending:
                        init_risk = abs(pos.entry_px - (pos.stop_px or pos.entry_px)) or (pos.entry_px * self.r.max_stop_distance_pct / 100)
                        r_now = ((pos.mark_px - pos.entry_px) if long else (pos.entry_px - pos.mark_px)) / init_risk if init_risk else 0
                        new_stop = a.stop_loss_px if a.stop_loss_px is not None else pos.stop_px
                        locked = (new_stop is not None) and ((new_stop >= pos.entry_px) if long else (new_stop <= pos.entry_px))
                        if not (r_now >= 1.0 and locked):
                            return Verdict(False, f"target extension needs a protected trade: position {r_now:+.1f}R, stop {'locked' if locked else 'NOT at breakeven'} - raise the stop to entry first", a)
                        if a.confidence < self.r.tp_extend_min_confidence:
                            return Verdict(False, f"target extension needs stated confidence >= {self.r.tp_extend_min_confidence:.0%} that the move continues (you gave {a.confidence:.0%})", a)
            if a.kind == "pm_update":
                q = next((q for q in snap.pm if q.token_id == a.token_id), None)
                if not q:
                    return Verdict(False, f"no PM position for token {a.token_id}", a)
                if a.stop_loss_px is None and a.take_profit_px is None:
                    return Verdict(False, "pm_update needs a stop_loss_px and/or take_profit_px (nothing to set)", a)
                if a.stop_loss_px is not None and not (0 < a.stop_loss_px < q.cur_price):
                    return Verdict(False, f"PM stop {a.stop_loss_px} must be below the current token price {q.cur_price:.3f}", a)
                if a.stop_loss_px is not None and q.stop_px is not None and a.stop_loss_px < q.stop_px:
                    return Verdict(False, f"would loosen the PM stop {q.stop_px}->{a.stop_loss_px} - never loosen a stop", a)
                if a.take_profit_px is not None and not (q.cur_price < a.take_profit_px <= 1.0):
                    return Verdict(False, f"PM target {a.take_profit_px} must be above the current token price {q.cur_price:.3f} and <= 1.0", a)
                if a.take_profit_px is not None and q.tp_px is not None and a.take_profit_px > q.tp_px:
                    locked = (a.stop_loss_px if a.stop_loss_px is not None else q.stop_px) is not None and \
                             (a.stop_loss_px if a.stop_loss_px is not None else q.stop_px) >= q.avg_price
                    if not (q.cur_price >= q.avg_price * 1.15 and locked):
                        return Verdict(False, "PM target extension needs the token >= +15% from cost and a stop at/above cost", a)
                    if a.confidence < self.r.tp_extend_min_confidence:
                        return Verdict(False, f"PM target extension needs stated confidence >= {self.r.tp_extend_min_confidence:.0%} (you gave {a.confidence:.0%})", a)
            return Verdict(True, "risk-reducing", a)

        # ---- everything below adds risk --------------------------------------
        halted, why = self.daily_halted(snap)
        if halted:
            return Verdict(False, f"NEW RISK BLOCKED - {why}", a)

        # rate limits
        prior = [o for o in self.state.recent_orders(self.r.min_seconds_between_orders)
                 if o["ts"] < cycle_start_ts and o["action"].get("kind") not in RISK_REDUCING]
        if prior:
            return Verdict(False, f"cooldown: <{self.r.min_seconds_between_orders}s since last order", a)
        hourly = [o for o in self.state.recent_orders(3600) if o["action"].get("kind") != "update_stop"]   # stop moves never block entries
        if len(hourly) >= self.r.max_orders_per_hour:
            return Verdict(False, f"rate limit: {self.r.max_orders_per_hour} orders/hour (entries + closes)", a)

        if not a.size_usd or a.size_usd <= 0:
            if a.kind in ("pm_buy", "spot_buy"):
                # model forgot the size: default to a small starter position rather than losing the idea
                a.size_usd = max(self.r.min_order_usd, round(eq * 0.03, 2))
                clamps = [f"size missing -> default ${a.size_usd:.2f}"]
            else:
                return Verdict(False, "size_usd required and > 0", a)
        clamps = locals().get("clamps", [])
        if a.size_usd < self.r.min_order_usd:
            return Verdict(False, f"size ${a.size_usd:.2f} < min ${self.r.min_order_usd}", a)

        # position count (adding to an existing coin doesn't count as new)
        existing = {p.coin for p in snap.perps} | {p.market_id for p in snap.pm} | {s.coin for s in snap.spot if s.value_usd > 1}
        key = a.coin if a.kind in ("open_perp", "spot_buy") else a.market_id
        if key not in existing and snap.open_position_count >= self.r.max_open_positions:
            return Verdict(False, f"max open positions ({self.r.max_open_positions}) reached", a)

        # per-position notional cap
        cap_pct = self.r.prediction_market_max_pct_equity if a.kind == "pm_buy" else self.r.max_position_pct_equity
        cur_notional = 0.0
        if a.kind == "open_perp":
            cur_notional = sum(abs(p.notional_usd) for p in snap.perps if p.coin == a.coin)
        elif a.kind == "pm_buy":
            cur_notional = sum(p.value_usd for p in snap.pm if p.market_id == a.market_id)
        room = eq * cap_pct / 100 - cur_notional
        if room < self.r.min_order_usd:
            return Verdict(False, f"position cap {cap_pct}% of equity already used for {key}", a)
        if a.size_usd > room:
            clamps.append(f"size ${a.size_usd:.0f}->${room:.0f} (per-position cap {cap_pct}%)")
            a.size_usd = room

        # gross exposure cap
        gross_room = eq * self.r.max_gross_exposure_pct / 100 - snap.gross_exposure_usd
        if gross_room < self.r.min_order_usd:
            return Verdict(False, f"gross exposure cap {self.r.max_gross_exposure_pct}% reached", a)
        if a.size_usd > gross_room:
            clamps.append(f"size ->${gross_room:.0f} (gross exposure cap)")
            a.size_usd = gross_room

        # never hold both outcomes of one market: that only locks in the loss with extra fees
        if a.kind == "pm_buy":
            other = [q for q in snap.pm if q.market_id == a.market_id and q.token_id != a.token_id and q.shares > 0]
            if other:
                return Verdict(False, f"you already hold '{other[0].outcome}' in this market - if your view changed, pm_sell it instead of buying '{a.outcome}'", a)
        # prediction-market total cap
        if a.kind == "pm_buy":
            pm_room = eq * self.r.prediction_market_max_total_pct / 100 - snap.pm_total_usd()
            if pm_room < self.r.min_order_usd:
                return Verdict(False, f"prediction-market total cap {self.r.prediction_market_max_total_pct}% reached", a)
            if a.size_usd > pm_room:
                clamps.append(f"size ->${pm_room:.0f} (PM total cap)")
                a.size_usd = pm_room
            if a.limit_price is None or not (0.01 <= a.limit_price <= 0.99):
                return Verdict(False, "pm_buy needs limit_price in [0.01, 0.99]", a)
            if not a.token_id:
                return Verdict(False, "pm_buy needs token_id", a)

        # perp specifics
        if a.kind == "open_perp":
            if a.side not in ("long", "short"):
                return Verdict(False, "open_perp needs side long|short", a)
            if a.coin not in self.cfg.universe.perps:
                return Verdict(False, f"{a.coin} not in allowed perp universe", a)
            # bucket cap: each bucket (majors / midcaps / movers) may hold at most max_positions perps
            bname = self.cfg.universe.bucket_of(a.coin)
            if bname and a.coin not in {p.coin for p in snap.perps}:
                bcfg = self.cfg.universe.buckets[bname]
                held_in_bucket = [p.coin for p in snap.perps if self.cfg.universe.bucket_of(p.coin) == bname]
                if len(held_in_bucket) >= bcfg.max_positions:
                    return Verdict(False, f"bucket '{bname}' full ({len(held_in_bucket)}/{bcfg.max_positions}: {held_in_bucket})", a)
            # correlation guard: crypto perps move together. (1) count cap, relaxed when the regime confirms the
            # direction; (2) combined $-at-risk (distance to stop x notional) of same-direction perps vs equity.
            same_pos = [p for p in snap.perps if p.coin != a.coin and ((p.size > 0) == (a.side == "long"))]
            strength, why_s = trend_strength(market, a.side)
            ladder = self.r.same_direction_caps or [3]
            cap = ladder[min(strength, len(ladder) - 1)]
            if len(same_pos) >= cap:
                return Verdict(False, f"correlation cap: already {a.side} {[p.coin for p in same_pos]} - max {cap} same-direction perps at trend strength {strength}/4 ({why_s})", a)
            def _beta(coin):
                if not self.r.beta_weighted_risk:
                    return 1.0
                b = abs((((market or {}).get("perps", {}) or {}).get(coin) or {}).get("beta_btc") or 1.0)
                return min(max(b, 0.3), 2.0)               # floor 0.3 (nothing is truly uncorrelated), cap 2
            def _risk(p):
                base = abs(p.mark_px - p.stop_px) / p.mark_px * abs(p.notional_usd) if p.stop_px and p.mark_px else abs(p.notional_usd) * (self.r.max_stop_distance_pct / 100)
                return base * _beta(p.coin)
            existing_risk = sum(_risk(p) for p in same_pos)
            ref_px = next((p.mark_px for p in snap.perps if p.coin == a.coin), None) or (((market or {}).get("perps", {}) or {}).get(a.coin) or {}).get("mark")
            new_risk = ((abs(ref_px - a.stop_loss_px) / ref_px * a.size_usd) if (ref_px and a.stop_loss_px) else a.size_usd * (self.r.max_stop_distance_pct / 100)) * _beta(a.coin)
            budget = eq * self.r.max_same_direction_risk_pct / 100
            if existing_risk + new_risk > budget:
                room = budget - existing_risk
                if room < self.r.min_order_usd * (self.r.max_stop_distance_pct / 100):
                    return Verdict(False, f"same-direction risk budget used: ${existing_risk:.2f} at risk across {a.side}s vs ${budget:.2f} ({self.r.max_same_direction_risk_pct}% of equity)", a)
                scale = room / new_risk
                clamps.append(f"size ${a.size_usd:.0f}->${a.size_usd*scale:.0f} (same-direction risk budget)")
                a.size_usd = a.size_usd * scale
            # re-entry cooldown: a coin that just stopped you out is blocked in that direction (unless it is waking up)
            blocks = self.state.get("reentry_block") or {}
            bkey = f"{a.coin}|{a.side}"
            if bkey in blocks and (time.time() - blocks[bkey]) < self.r.reentry_cooldown_min * 60:
                waking = (((market or {}).get("perps", {}) or {}).get(a.coin) or {}).get("vol_expansion") or 0
                if waking < 1.5:
                    left = self.r.reentry_cooldown_min - (time.time() - blocks[bkey]) / 60
                    return Verdict(False, f"re-entry cooldown: {a.coin} {a.side} stopped out recently - {left:.0f}m left (a wake-up overrides)", a)
            # chop-regime entry budget, SCOPED: chop is where stop-out churn happens, but (a) PM buys never count,
            # (b) a coin trending cleanly in the trade's direction (1h structure + 15m agree) is exempt - trend-following
            # on a trending coin is not chop churn even when BTC is indecisive, (c) only counter-trend perp entries
            # actually FILLED during chop eat the budget (tagged [chop-entry] on the action).
            if regime.startswith("chop") and self.r.chop_max_entries_per_day and a.kind == "open_perp":
                md_c = ((market or {}).get("perps", {}) or {}).get(a.coin) or {}
                t1h_up = md_c.get("ema20_above_ema50") is True and md_c.get("above_sma50_1h")
                t1h_dn = md_c.get("ema20_above_ema50") is False and not md_c.get("above_sma50_1h")
                t15 = md_c.get("trend_15m")
                aligned = (a.side == "long" and t1h_up and t15 in ("up", None)) or \
                          (a.side == "short" and t1h_dn and t15 in ("down", None))
                if not aligned:
                    if self.state.chop_entries_today() >= self.r.chop_max_entries_per_day:
                        return Verdict(False, f"chop budget: {self.r.chop_max_entries_per_day}/day counter-trend entries in chop used (trend-aligned and trend-regime entries are uncapped)", a)
                    a.reason = (a.reason or "") + " [chop-entry]"
            # anti-chase: entering at the extreme of the band with extreme RSI is buying the top / selling the bottom
            md = ((market or {}).get("perps", {}) or {}).get(a.coin) or {}
            bb, rsi = md.get("bb_pos_1h"), md.get("rsi14_1h")
            if self.r.anti_chase_bb and bb is not None and rsi is not None:
                if a.side == "long" and bb > self.r.anti_chase_bb and rsi > self.r.anti_chase_rsi:
                    return Verdict(False, f"chasing: {a.coin} at top of band (bb {bb:.2f} > {self.r.anti_chase_bb}, RSI {rsi:.0f} > {self.r.anti_chase_rsi:.0f}) - wait for the pullback to EMA20/SMA50", a)
                if a.side == "short" and bb < (1 - self.r.anti_chase_bb) and rsi < (100 - self.r.anti_chase_rsi):
                    return Verdict(False, f"chasing: {a.coin} at bottom of band (bb {bb:.2f}, RSI {rsi:.0f}) - wait for the bounce", a)
            # initial stop must clear normal noise: >= min_entry_stop_atr_mult x 1h ATR from current price
            atr_e = md.get("atr14_1h_pct")
            ref_e = next((pp.mark_px for pp in snap.perps if pp.coin == a.coin), None)
            if atr_e and a.stop_loss_px and self.r.min_entry_stop_atr_mult:
                # use the coin's mark from market data when we don't hold it (snap has no mark for new coins)
                mark_e = ref_e or md.get("mark")
                if mark_e:
                    dist_e = abs(mark_e - a.stop_loss_px) / mark_e * 100
                    need_e = min(atr_e * self.r.min_entry_stop_atr_mult, self.r.max_stop_distance_pct * 0.9)
                    if dist_e < need_e:
                        return Verdict(False, f"initial stop {dist_e:.2f}% from price < {self.r.min_entry_stop_atr_mult}x ATR ({need_e:.2f}%) - normal noise would clip it; widen the stop (size shrinks automatically)", a)
            # carry: don't open a position that pays extreme funding
            if funding and a.coin in funding:
                f8 = funding[a.coin]
                if (a.side == "long" and f8 > self.r.max_adverse_funding_pct_8h) or (a.side == "short" and f8 < -self.r.max_adverse_funding_pct_8h):
                    return Verdict(False, f"adverse funding {f8:+.4f}%/8h for a {a.side} (max {self.r.max_adverse_funding_pct_8h}%)", a)
            lev = a.leverage or 1
            if lev > self.r.max_leverage:
                clamps.append(f"leverage {lev}->{self.r.max_leverage}")
                a.leverage = self.r.max_leverage
            elif lev < 1:
                a.leverage = 1
            else:
                a.leverage = lev
            # margin actually available?
            margin_needed = a.size_usd / a.leverage
            if margin_needed > snap.available_usd * 0.95:
                new_size = snap.available_usd * 0.95 * a.leverage
                if new_size < self.r.min_order_usd:
                    return Verdict(False, f"insufficient margin (available ${snap.available_usd:.2f})", a)
                clamps.append(f"size ->${new_size:.0f} (available margin)")
                a.size_usd = new_size
            if self.r.require_stop_loss:
                if a.stop_loss_px is None:
                    return Verdict(False, "open_perp requires stop_loss_px", a)
                ref = next((p.mark_px for p in snap.perps if p.coin == a.coin), None)
                # entry ref price is validated in the executor against live mark;
                # here we sanity check direction + distance using the LLM's implied entry (tp/sl geometry)
                if ref is not None and not self._stop_is_protective(a.side == "long", ref, a.stop_loss_px):
                    return Verdict(False, "stop on wrong side of price", a)
                if ref is not None:
                    dist = abs(ref - a.stop_loss_px) / ref * 100
                    if dist > self.r.max_stop_distance_pct:
                        return Verdict(False, f"stop {dist:.1f}% away > max {self.r.max_stop_distance_pct}%", a)

        if a.kind == "spot_buy":
            if a.coin not in self.cfg.universe.spot:
                return Verdict(False, f"{a.coin} not in allowed spot universe", a)
            if a.size_usd > snap.available_usd * 0.98:
                a.size_usd = snap.available_usd * 0.98
                clamps.append("size clamped to available cash")
                if a.size_usd < self.r.min_order_usd:
                    return Verdict(False, "insufficient cash for spot buy", a)

        reason = "approved" + (f" (clamped: {'; '.join(clamps)})" if clamps else "")
        return Verdict(True, reason, a)

    @staticmethod
    def _stop_is_protective(is_long: bool, px: float, stop: float) -> bool:
        return stop < px if is_long else stop > px

    def validate_stop_vs_entry(self, a: Action, entry_px: float) -> Tuple[bool, str]:
        """Called by executor with the real mark price just before sending."""
        if a.kind != "open_perp" or a.stop_loss_px is None:
            return True, ""
        if not self._stop_is_protective(a.side == "long", entry_px, a.stop_loss_px):
            return False, f"stop {a.stop_loss_px} on wrong side of entry {entry_px}"
        dist = abs(entry_px - a.stop_loss_px) / entry_px * 100
        if dist > self.r.max_stop_distance_pct:
            return False, f"stop {dist:.1f}% from entry > max {self.r.max_stop_distance_pct}%"
        # a stop this close to entry with this leverage would be inside liquidation? (rough)
        liq_dist = 100 / (a.leverage or 1) * 0.9
        if dist >= liq_dist:
            return False, f"stop distance {dist:.1f}% is at/inside est. liquidation distance {liq_dist:.1f}%"
        return True, ""
