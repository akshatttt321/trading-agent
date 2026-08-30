"""
Risk-reward model. Deterministic. Runs after the risk gate on every risk-ADDING action.

  1. Reward:risk from the LLM's own stop / take-profit geometry must be >= min_reward_risk.
  2. Expected value in R using the LLM's stated confidence p:  EV_R = p*RR - (1-p)  must be > 0.
  3. Sizing: fractional Kelly on (p, RR), capped so a stop-out costs <= max_risk_per_trade_pct of equity.
     Final size = min(LLM size, Kelly size, risk-cap size) * learner multiplier.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .config import Config
from .models import AccountSnapshot, Action


@dataclass
class RRVerdict:
    ok: bool
    reason: str
    action: Action
    risk_usd: float = 0.0      # $ lost if the stop is hit (perp) or outcome loses (PM)
    reward_risk: float = 0.0
    ev_r: float = 0.0


class RiskRewardModel:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.rr = cfg.rr

    def assess(self, a: Action, snap: AccountSnapshot, entry_px: Optional[float], learner_mult: float = 1.0,
               pm_meta: Optional[dict] = None, marks: Optional[dict] = None) -> RRVerdict:
        a = a.model_copy(deep=True)
        eq = snap.equity_usd
        p = min(max(a.confidence, 0.01), 0.99)
        max_risk_usd = eq * self.rr.max_risk_per_trade_pct / 100

        if a.kind == "open_perp":
            if entry_px is None or a.stop_loss_px is None:
                return RRVerdict(False, "no entry/stop price", a)
            risk_frac = abs(entry_px - a.stop_loss_px) / entry_px
            if risk_frac <= 0:
                return RRVerdict(False, "zero stop distance", a)
            if a.take_profit_px is None:
                return RRVerdict(False, "take_profit_px required for reward:risk assessment", a)
            reward_frac = abs(a.take_profit_px - entry_px) / entry_px
            if (a.side == "long" and a.take_profit_px <= entry_px) or (a.side == "short" and a.take_profit_px >= entry_px):
                return RRVerdict(False, "take-profit on wrong side of entry", a)
            rr = reward_frac / risk_frac
            if rr < self.rr.min_reward_risk:
                return RRVerdict(False, f"reward:risk {rr:.2f} < min {self.rr.min_reward_risk}", a, reward_risk=rr)
            ev_r = p * rr - (1 - p)
            if ev_r <= 0:
                return RRVerdict(False, f"negative EV: p={p:.2f} RR={rr:.2f} -> EV={ev_r:.2f}R", a, reward_risk=rr, ev_r=ev_r)
            kelly = (p * rr - (1 - p)) / rr  # fraction of equity to RISK
            kelly_risk_usd = max(kelly, 0) * self.rr.kelly_fraction * eq
            risk_budget = min(kelly_risk_usd, max_risk_usd) * learner_mult
            size_cap = risk_budget / risk_frac
            orig = a.size_usd or 0
            # margin floor: every trade commits >= min_margin_usd of margin (notional = leverage x margin).
            # Risk caps keep PRIMACY: the floor never overrides the risk budget or the per-position notional cap.
            floor_usd = (a.leverage or 1) * self.cfg.risk.min_margin_usd
            notional_cap = eq * self.cfg.risk.max_position_pct_equity / 100
            a.size_usd = round(min(max(orig, floor_usd), size_cap, notional_cap), 2)
            risk_usd = a.size_usd * risk_frac
            note = f"RR={rr:.2f} p={p:.2f} EV={ev_r:.2f}R kelly_risk=${kelly_risk_usd:.0f} cap_risk=${max_risk_usd:.0f} learner x{learner_mult:.2f}"
            if a.size_usd < self.cfg.risk.min_order_usd:
                return RRVerdict(False, f"sized below min order after RR model ({note})", a, risk_usd, rr, ev_r)
            if abs(a.size_usd - orig) > 0.5:
                note = f"size ${orig:.0f}->${a.size_usd:.0f}" + (" (margin floor)" if a.size_usd > orig else "") + "; " + note
            return RRVerdict(True, note, a, risk_usd, rr, ev_r)

        if a.kind == "pm_buy" and a.stop_loss_px is not None and a.take_profit_px is not None:
            # SWING mode: trade the token price with a stop and a target (the final verdict is irrelevant)
            price = a.limit_price or 0
            pm = self.cfg.universe.prediction_markets
            if not (pm.swing_min_price <= price <= pm.max_buy_price):
                return RRVerdict(False, f"PM swing entry {price:.2f} outside [{pm.swing_min_price}, {pm.max_buy_price}] (spread / payoff)", a)
            if not (0 < a.stop_loss_px < price < a.take_profit_px <= 1.0):
                return RRVerdict(False, "PM swing needs stop < entry < target <= 1.0", a)
            if a.take_profit_px - price < pm.swing_min_target_gap:
                return RRVerdict(False, f"PM swing target only {a.take_profit_px - price:.3f} above entry (min {pm.swing_min_target_gap} - the spread eats less)", a)
            meta = (pm_meta or {}).get(str(a.market_id)) or {}
            if meta.get("ends"):
                from .market_data import hours_to
                h = hours_to(meta["ends"])
                if h < pm.swing_min_hours:
                    return RRVerdict(False, f"PM swing: {h:.1f}h to resolution < min {pm.swing_min_hours}h (no time value left)", a)
            risk_frac = (price - a.stop_loss_px) / price
            reward_frac = (a.take_profit_px - price) / price
            rr = reward_frac / risk_frac
            if rr < self.rr.min_reward_risk:
                return RRVerdict(False, f"PM swing reward:risk {rr:.2f} < min {self.rr.min_reward_risk}", a, reward_risk=rr)
            ev_r = p * rr - (1 - p)
            if ev_r <= 0:
                return RRVerdict(False, f"PM swing negative EV: p={p:.2f} RR={rr:.2f}", a, reward_risk=rr, ev_r=ev_r)
            kelly = (p * rr - (1 - p)) / rr
            risk_budget = min(max(kelly, 0) * self.rr.kelly_fraction * eq, max_risk_usd) * learner_mult
            size_cap = risk_budget / risk_frac
            orig = a.size_usd or 0
            # min-order floor: a $8 proposal into a $10 venue minimum is a guaranteed rejection - round UP to the
            # minimum when the risk budget and PM cap allow it; risk caps keep primacy (still rejected below if not).
            pm_cap = eq * self.cfg.risk.prediction_market_max_pct_equity / 100
            a.size_usd = round(min(max(orig, self.cfg.risk.min_order_usd), size_cap, pm_cap), 2)
            risk_usd = a.size_usd * risk_frac
            note = f"PM-SWING RR={rr:.2f} p={p:.2f} EV={ev_r:.2f}R stop {a.stop_loss_px:.2f} target {a.take_profit_px:.2f} learner x{learner_mult:.2f}"
            if a.size_usd < self.cfg.risk.min_order_usd:
                return RRVerdict(False, f"sized below min order after RR model ({note})", a, risk_usd, rr, ev_r)
            return RRVerdict(True, note, a, risk_usd, rr, ev_r)

        if a.kind == "pm_buy":
            price = a.limit_price or 0
            pm = self.cfg.universe.prediction_markets
            if not (0.01 <= price <= 0.99):
                return RRVerdict(False, "pm price out of range", a)
            if price > pm.max_buy_price:
                return RRVerdict(False, f"PM price {price:.2f} > max {pm.max_buy_price} (paying {price*100:.0f}c for a $1 payoff)", a)
            meta = (pm_meta or {}).get(str(a.market_id)) or {}
            from .market_data import hours_to, parse_price_market
            pq = parse_price_market(meta.get("question", ""))
            is_crypto_price = bool(pq)
            edge = p - price
            if is_crypto_price:
                # crypto price binaries: the "same-day coin flip near the strike" guards apply
                if meta.get("ends"):
                    h = hours_to(meta["ends"])
                    if h < pm.min_hours_to_resolution:
                        return RRVerdict(False, f"crypto PM resolves in {h:.1f}h < min {pm.min_hours_to_resolution}h (same-day near-strike coin flip)", a)
                if pq[0] in (marks or {}):
                    dist = abs((marks[pq[0]] - pq[1]) / pq[1]) * 100
                    if dist < pm.min_strike_distance_pct:
                        return RRVerdict(False, f"crypto PM strike ${pq[1]:,.0f} only {dist:.2f}% from {pq[0]} spot (min {pm.min_strike_distance_pct}%)", a)
            else:
                # event markets (sports/politics/macro): timing doesn't matter, but a HUGE claimed edge almost always
                # means the grounded research is wrong or the outcome token is misread - refuse it
                if edge > pm.max_research_edge:
                    return RRVerdict(False, f"implausible edge {edge:+.2f} (research {p:.2f} vs market {price:.2f} > max {pm.max_research_edge}) - price/outcome-mapping unreliable, needs re-check", a)
            need = self.rr.pm_min_edge + max(price - 0.5, 0) * pm.edge_slope
            if edge < need:
                return RRVerdict(False, f"PM edge {edge:+.3f} < required {need:.3f} at price {price:.2f} (conf {p:.2f})", a)
            b = (1 - price) / price               # net odds
            rr = b
            ev_r = p * b - (1 - p)                # per $ risked
            kelly = (p * b - (1 - p)) / b
            kelly_usd = max(kelly, 0) * self.rr.kelly_fraction * eq
            budget = min(kelly_usd, max_risk_usd) * learner_mult
            orig = a.size_usd or 0
            pm_cap = eq * self.cfg.risk.prediction_market_max_pct_equity / 100
            a.size_usd = round(min(max(orig, self.cfg.risk.min_order_usd), budget, pm_cap), 2)   # min-order round-up; risk caps keep primacy
            note = f"PM edge={edge:+.2f} odds={b:.2f} EV={ev_r:.2f} kelly=${kelly_usd:.0f} learner x{learner_mult:.2f}"
            if a.size_usd < self.cfg.risk.min_order_usd:
                return RRVerdict(False, f"sized below min order after RR model ({note})", a, a.size_usd, rr, ev_r)
            return RRVerdict(True, note, a, a.size_usd, rr, ev_r)

        if a.kind == "spot_buy":
            # spot has no stop; treat whole position as risk capital, cap by max_risk_per_trade * 4 (spot is 1x, slow)
            cap = max_risk_usd * 4 * learner_mult
            orig = a.size_usd or 0
            a.size_usd = round(min(orig, cap), 2)
            if a.size_usd < self.cfg.risk.min_order_usd:
                return RRVerdict(False, "spot size below min after cap", a)
            return RRVerdict(True, f"spot cap ${cap:.0f} learner x{learner_mult:.2f}", a, a.size_usd * 0.15, 1.0, 0.0)

        return RRVerdict(True, "n/a", a)
