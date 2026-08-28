"""Main loop: data -> LLM proposes -> risk gate -> risk/reward model -> learner sizing -> execute -> journal."""
from __future__ import annotations

import argparse
import sys
import time
from typing import Dict, List, Optional, Tuple

from .config import DATA_DIR, KILL_FILE, ROOT, Config, load_config
from .learner import Learner, regime_tag
from .llm import build_manager_message, Brain, build_user_message
from .market_data import MarketData
from .models import AccountSnapshot, Action, ExecResult
from .notify import Notifier, console, log
from .risk import RiskGate, trend_strength
from .rr_model import RiskRewardModel
from .state import State
from .venues.base import Venue, merge_snapshots
from .venues.paper import PaperVenue

RISK_ADDING = {"open_perp", "spot_buy", "pm_buy"}
PM_KINDS = {"pm_buy", "pm_sell", "pm_update"}


def build_venues(cfg: Config, md: MarketData, state: State) -> Dict[str, Venue]:
    if cfg.is_paper:
        v = PaperVenue(cfg, state)
        return {"hl": v, "pm": v}
    from .venues.hyperliquid_venue import HyperliquidVenue
    venues: Dict[str, Venue] = {"hl": HyperliquidVenue(cfg, md)}
    if cfg.mode == "live" and cfg.poly_private_key and cfg.universe.prediction_markets.enabled:
        from .venues.polymarket_venue import PolymarketVenue
        venues["pm"] = PolymarketVenue(cfg)
    else:
        log.warning("prediction markets disabled (testnet mode or no POLY_PRIVATE_KEY)")
        cfg.universe.prediction_markets.enabled = False
    return venues


class Agent:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = State()
        self.notify = Notifier(cfg)
        self.md = MarketData(cfg)
        self.brain = Brain(cfg)
        self.risk = RiskGate(cfg, self.state)
        self.rr = RiskRewardModel(cfg)
        self.learner = Learner(cfg, self.state, notes_provider=self.brain.notes_provider if cfg.learner.postmortems else None)
        from .research import Researcher
        self.researcher = Researcher(cfg, self.state)
        self.venues = build_venues(cfg, self.md, self.state)
        self.unique_venues: List[Venue] = list({id(v): v for v in self.venues.values()}.values())

    # ------------------------------------------------------------------ helpers
    def snapshot(self, prices: Dict[str, float]) -> AccountSnapshot:
        return merge_snapshots(time.time(), [v.snapshot(prices) for v in self.unique_venues])

    def flatten_and_die(self, reason: str, prices: Dict[str, float]) -> None:
        self.notify.send(f"!!! KILL: {reason}. Flattening everything and stopping.", "error")
        for v in self.unique_venues:
            for r in v.flatten_all(prices):
                self.notify.send(f"   flatten: {r.detail}", "warning")
        KILL_FILE.write_text(f"{time.ctime()} {reason}\n")
        self.state.set("killed", reason)
        sys.exit(2)

    def _housekeep(self, prices: Dict[str, float]) -> None:
        """Venue maintenance (paper stop/TP triggers) -> journal the close + feed the learner."""
        for v in self.unique_venues:
            for ev in v.housekeeping(prices):
                text, pnl, key = ev.rsplit("|", 2)
                if text.startswith("SCALE-OUT"):
                    self.notify.send(f"   {text}", "warning")
                    self.state.record_order(self.state.last_cycle_id(), {"kind": "close_perp", "coin": key, "reason": "scale-out at +R", "confidence": 1.0},
                                            True, "auto: scale-out", {"ok": True, "detail": text, "raw": {"realized_pnl": float(pnl), "coin": key, "partial": True}})
                    if key in self.learner.open:
                        self.learner.open[key]["risk_usd"] = max(self.learner.open[key]["risk_usd"] * (1 - self.cfg.risk.scale_out_frac), 1e-6)
                        self.learner._save()
                    continue
                why = ("STOP hit" if text.startswith("STOP") else "TAKE-PROFIT hit" if text.startswith("TAKE") else
                       "PM stop hit" if text.startswith("PM STOP") else "PM target hit" if text.startswith("PM TARGET") else "PM resolved")
                self.notify.send(f"   {text}", "warning")
                kind = "pm_sell" if len(str(key)) > 20 else "close_perp"       # PM token ids are 70+ digit strings
                self.state.record_order(self.state.last_cycle_id(), {"kind": kind, "coin": None if kind == "pm_sell" else key,
                                        "token_id": key if kind == "pm_sell" else None, "reason": why, "confidence": 1.0},
                                        True, "auto: " + why,
                                        {"ok": True, "detail": text, "raw": {"realized_pnl": float(pnl), "coin": key, "fill_px": prices.get(key)}})
                lesson = self.learner.record_close(key, float(pnl), prices.get(key), why)
                if lesson:
                    log.info(lesson)
        for ev in self.learner.update_shadows(prices):
            log.info(f"[dim]{ev}[/]")

    def _close_stale(self, snap: AccountSnapshot, prices: Dict[str, float], cycle_id: int) -> None:
        """Force-close perps older than risk.max_position_age_hours (stale theses drift)."""
        max_h = self.cfg.risk.max_position_age_hours
        if not max_h:
            return
        for p in snap.perps:
            opened = (self.learner.open.get(p.coin) or {}).get("ts")
            if not opened or time.time() - opened < max_h * 3600:
                continue
            a = Action(kind="close_perp", coin=p.coin, reason=f"stale: open {((time.time()-opened)/3600):.1f}h > {max_h}h", confidence=1.0)
            res = self.venues["hl"].execute(a, prices)
            self.state.record_order(cycle_id, a.model_dump(), True, "auto: stale position", res.model_dump())
            self.notify.send(f"AUTO-CLOSE {p.coin}: {a.reason} -> {res.detail}", "warning")
            if res.ok and res.raw and "realized_pnl" in res.raw:
                lesson = self.learner.record_close(p.coin, float(res.raw["realized_pnl"]), res.raw.get("fill_px"), "stale auto-close")
                if lesson:
                    log.info(lesson)

    def watch(self, prices: Optional[Dict[str, float]] = None) -> None:
        """Cheap between-cycle guard (no LLM): live prices -> paper stops/TPs, drawdown & kill checks."""
        if prices is None:
            prices = self.md.all_mids()
            if not prices:
                return
            prices = {**self.md.last_pm_prices, **prices}     # PM token prices from the last gather
        held_mids = {q.market_id for v in self.unique_venues for q in v.snapshot(prices).pm}
        if held_mids:                                       # fresh prices for held tokens so PM stops/targets fire on time
            from .market_data import pm_live_prices
            live = pm_live_prices(held_mids)
            prices.update(live)
            self.md.last_pm_prices.update(live)
        self._housekeep(prices)
        snap = self.snapshot(prices)
        # publish a live view (marks, uPnL, equity) so the dashboard updates every minute, not every cycle
        self.state.set("live_snapshot", {"ts": time.time(), "equity": snap.equity_usd, "snapshot": snap.model_dump()})
        kill = self.risk.check_kill(snap)
        if kill:
            self.flatten_and_die(kill, prices)

    def _autoprotect_pm(self, prices: Dict[str, float]) -> None:
        """Deterministic protection for held prediction-market tokens whose levels the model never set:
        stop ~ 45% below cost (or just under current if already lower), target ~ +60% (capped 0.9). Reversible
        by the model via pm_update / pm_sell. Prevents the reject-loop and leaves no unmanaged PM bet."""
        snap = self.snapshot(prices)
        for q in snap.pm:
            if q.stop_px is not None or q.tp_px is not None:
                continue
            cur = q.cur_price or q.avg_price
            stop = round(min(max(q.avg_price * 0.55, 0.02), cur * 0.9), 3)
            tp = round(max(min(max(q.avg_price * 1.6, cur * 1.1), 0.95), min(cur * 1.05, 0.99)), 3)
            if not (0 < stop < cur < tp <= 1.0):
                log.warning(f"auto-protect could not derive levels for '{q.outcome}' (cur {cur}) - leaving unmanaged")
                continue
            a = Action(kind="pm_update", token_id=q.token_id, stop_loss_px=stop, take_profit_px=tp,
                       reason="auto-protect: default levels", confidence=1.0)
            res = self.venues["pm"].execute(a, prices)
            if res.ok:
                self.notify.send(f"AUTO-PROTECT PM '{q.outcome}': stop {stop} target {tp} ({q.question[:40]})", "warning")

    def tick(self) -> str:
        """30s sensor: run the cheap guard, then decide whether anything warrants an immediate decision cycle.
        Returns a wake reason ('' = keep sleeping). Free - prices only, no LLM, cached indicators."""
        raw = self.md.all_mids()
        if not raw:
            return ""
        prices = {**self.md.last_pm_prices, **raw}
        self.watch(prices)
        resting = self.state.get("resting_orders") or []
        if resting:
            self._check_resting(resting, raw, prices)
        l = self.cfg.llm
        now = time.time()
        # 1) model-declared watch levels (one-shot alarms)
        levels = self.state.get("watch_levels") or []
        keep, hits = [], []
        for w in levels:
            if now - (w.get("ts") or now) > l.watch_level_ttl_hours * 3600:
                continue                                   # expired unhit
            px = raw.get(w.get("coin"))
            if px and ((w.get("direction") == "above" and px >= w["px"]) or (w.get("direction") == "below" and px <= w["px"])):
                hits.append(f"{w['coin']} {w['direction']} {w['px']}" + (f" [{w.get('note')}]" if w.get("note") else ""))
            else:
                keep.append(w)
        if hits:
            self.state.set("watch_levels", keep)           # hit levels are consumed
            return "watch level: " + "; ".join(hits[:3])
        if len(keep) != len(levels):
            self.state.set("watch_levels", keep)
        lm = getattr(self, "_last_market", None) or {}
        perps_md = lm.get("perps", {})
        # 2) manager wake conditions on open positions (cached 15m ATRs, fresh marks)
        snap = self.snapshot(prices)
        if (snap.perps or snap.pm) and l.manager_enabled:
            due = self._manage_due(snap, perps_md, now)
            if due:
                return "manager: " + due
        # 3) entry attention, price-only. Two guards so volatile markets don't spam the paid brain:
        #    (a) capacity: if the entry agent has no room to act, waking it is a guaranteed paid HOLD - skip;
        #    (b) the bar mirrors the quiet gate's REAL threshold (hold-streak + dead-hours multipliers), so the
        #        tick never wakes for a look the gate would refuse anyway.
        if len(snap.perps) >= self.cfg.risk.max_open_positions:
            return ""
        try:
            rooms = [b.get("room", 1) for b in ((self._limits_now(snap, lm) or {}).get("buckets") or {}).values()]
            if rooms and not any(rooms):
                return ""
        except Exception:
            log.exception("tick capacity check")
        streak = int(self.state.get("hold_streak") or 0)
        mult = min(1.0 + l.hold_streak_step * streak, l.hold_streak_max_mult)
        h_now = time.gmtime().tm_hour
        if l.dead_hours and l.dead_hours[0] <= h_now < l.dead_hours[1]:
            mult *= l.dead_hour_mult
        bar_mult = l.attention_threshold * mult
        last_px = self.state.get("last_llm_prices") or {}
        for c, ref in last_px.items():
            if c in raw and ref and c in perps_md:
                atr_c = perps_md[c].get("atr14_1h_pct")
                bar = max(atr_c * l.move_atr_fraction, 0.05) if atr_c else l.quiet_move_pct
                if abs(raw[c] / ref - 1) * 100 / bar >= bar_mult:
                    return f"{c} moved {abs(raw[c] / ref - 1) * 100:.2f}% since last look"
        return ""

    def _throttle_mult(self) -> float:
        """Equity-curve throttle: 2+ consecutive stop-outs -> size x loss_streak_throttle for loss_streak_hours;
        the day after a losing day -> x losing_day_mult. Composes multiplicatively; logged when active."""
        r = self.cfg.risk
        m = 1.0
        st = self.state.get("exit_streak") or {}
        if st.get("losses", 0) >= 2 and time.time() - st.get("ts", 0) < r.loss_streak_hours * 3600:
            m *= r.loss_streak_throttle
        if (self.state.get("prev_day_pnl") or 0) < 0:
            m *= r.losing_day_mult
        if m < 1.0:
            log.info(f"[dim]throttle: sizing x{m:.2f} (loss streak {st.get('losses',0)}, prev day {self.state.get('prev_day_pnl')})[/]")
        return m

    def _pm_due(self, snap: AccountSnapshot, prices: Dict[str, float]) -> bool:
        """Prediction markets run on their OWN cadence, separate from perps: every pm_interval_min, or sooner if a held
        token moved >= pm_move_trigger_pct, or a held PM position has no stop/target yet."""
        if not self.cfg.universe.prediction_markets.enabled:
            return False
        if any(q.stop_px is None and q.tp_px is None for q in snap.pm):
            return True
        last = self.state.get("last_pm_ts") or 0
        if time.time() - last >= self.cfg.llm.pm_interval_min * 60:
            return True
        lastpx = self.state.get("last_pm_prices_seen") or {}
        for q in snap.pm:
            lp = lastpx.get(q.token_id)
            if lp and abs(q.cur_price - lp) / lp * 100 >= self.cfg.llm.pm_move_trigger_pct:
                return True
        return False

    def _is_loss_exit(self, a: Action, snap: AccountSnapshot) -> bool:
        if a.kind == "close_perp":
            p = next((p for p in snap.perps if p.coin == a.coin), None)
            return bool(p and p.unrealized_pnl < 0)
        if a.kind == "pm_sell":
            q = next((q for q in snap.pm if q.token_id == a.token_id), None)
            return bool(q and q.cur_price < q.avg_price)
        if a.kind == "spot_sell":
            return False
        return False

    def _limits_now(self, snap: AccountSnapshot, market: Dict) -> Dict:
        """What the model may still open right now: same-direction allowance (trend-strength ladder), bucket caps, total."""
        r = self.cfg.risk
        longs = [p.coin for p in snap.perps if p.size > 0]
        shorts = [p.coin for p in snap.perps if p.size < 0]
        out: Dict = {}
        for side, held in (("long", longs), ("short", shorts)):
            st, why = trend_strength(market, side)
            ladder = r.same_direction_caps or [3]
            cap = ladder[min(st, len(ladder) - 1)]
            out[f"{side}s"] = {"held": held, "allowed": cap, "room": max(cap - len(held), 0), "trend_strength": f"{st}/4", "why": why}
        u = self.cfg.universe
        if u.buckets:
            out["buckets"] = {}
            for name, b in u.buckets.items():
                held_b = [p.coin for p in snap.perps if u.bucket_of(p.coin) == name]
                out["buckets"][name] = {"held": held_b, "max": b.max_positions, "room": max(b.max_positions - len(held_b), 0)}
        out["total"] = {"held": snap.open_position_count, "max": r.max_open_positions}
        pm_no_levels = [q.token_id for q in snap.pm if q.stop_px is None and q.tp_px is None]
        if pm_no_levels:
            out["pm_positions_without_stop_target"] = [{"token_id": q.token_id, "outcome": q.outcome, "avg": q.avg_price,
                                                        "cur": q.cur_price, "question": q.question[:60]}
                                                       for q in snap.pm if q.stop_px is None and q.tp_px is None]
        return out

    def _select_shown(self, snap: AccountSnapshot, prices: Dict[str, float], market: Dict) -> Dict[str, str]:
        """Bucket scheduling: which coins go into this cycle's prompt. Returns {coin: bucket}.
        Due = bucket interval elapsed since last shown, or held, or big move / signal flip since last shown."""
        u = self.cfg.universe
        if not u.buckets:
            return {c: "all" for c in market.get("perps", {})}
        last_ts = self.state.get("shown_ts") or {}
        last_px = self.state.get("shown_px") or {}
        last_key = self.state.get("shown_key") or {}
        held = {p.coin for p in snap.perps}
        perps = market.get("perps", {})
        now = time.time()
        shown: Dict[str, str] = {}
        for bname, b in u.buckets.items():
            cands = []
            for c in b.coins:
                if c not in perps:
                    continue
                atr_c = (perps.get(c) or {}).get("atr14_1h_pct")
                bar = max(atr_c * self.cfg.llm.move_atr_fraction, 0.05) if atr_c else self.cfg.llm.quiet_move_pct
                move = abs(prices.get(c, 0) / last_px[c] - 1) * 100 / bar if last_px.get(c) and prices.get(c) else 0.0
                flip = 1.0 if (last_key.get(c) is not None and perps[c].get("_key") != last_key.get(c)) else 0.0
                elapsed_ok = (now - last_ts.get(c, 0)) >= b.look_every_min * 60
                interest = (100.0 if c in held else 0.0) + move + flip
                if c in held or elapsed_ok or interest >= 1.0:
                    cands.append((interest, c))
            cands.sort(reverse=True)
            for _, c in cands[:b.max_shown]:
                shown[c] = bname
        for c in held:               # never hide a held coin
            if c in perps and c not in shown:
                shown[c] = u.bucket_of(c) or "held"
        seen_exp = self.state.get("seen_expansion") or {}
        for c, v in perps.items():   # waking coins jump the queue - one-shot, same rule as the attention gate
            exp = v.get("vol_expansion") or 0
            if exp >= self.cfg.llm.wakeup_expansion and exp > seen_exp.get(c, 0) + 0.1 and c not in shown:
                shown[c] = (u.bucket_of(c) or "all") + "+waking"
        return shown

    def _mark_shown(self, shown: Dict[str, str], prices: Dict[str, float], market: Dict) -> None:
        ts = self.state.get("shown_ts") or {}; px = self.state.get("shown_px") or {}; key = self.state.get("shown_key") or {}
        now = time.time()
        for c in shown:
            ts[c] = now; px[c] = prices.get(c, px.get(c)); key[c] = (market.get("perps", {}).get(c) or {}).get("_key")
        self.state.set("shown_ts", ts); self.state.set("shown_px", px); self.state.set("shown_key", key)

    def _manage_positions(self, snap: AccountSnapshot, prices: Dict[str, float], market: Dict,
                          cycle_id: int, cycle_start_ts: float, funding: Dict, regime: str) -> bool:
        """Second brain: cheap position manager on its own fast cadence. Entry decisions stay with the (expensive)
        entry agent behind the attention gate; open positions get LLM judgement even on quiet cycles."""
        l = self.cfg.llm
        if not (l.manager_enabled and self.brain.manager):
            return False
        if not (snap.perps or snap.pm or snap.spot):
            return False
        today = self.state.get("tokens_today") or {}
        if today.get("day") == time.strftime("%Y-%m-%d", time.gmtime()) and today.get("cost_usd", 0.0) >= l.max_usd_per_day:
            return False                                       # spend cap: deterministic housekeeping still protects
        now = time.time()
        due = self._manage_due(snap, market.get("perps", {}), now)
        if not due:
            return False
        msg = build_manager_message(self.cfg, snap, market, self.state.get("starting_equity") or snap.equity_usd)
        try:
            decision, _raw = self.brain.propose_manage(msg)
        except Exception:
            log.exception("manager call failed")
            return False
        self.state.set("last_manage_ts", now)
        self.state.set("last_manage_prices", {p.coin: p.mark_px for p in snap.perps})
        self.state.set("manage_seen_levels", {p.coin: f"{p.stop_px}|{p.tp_px}" for p in snap.perps})
        self.state.set("last_manage_upnl", sum(p.unrealized_pnl for p in snap.perps))
        log.info(f"[bold]manage[/] ({due}): {decision.market_view}")
        self._managed = {"due": due, "view": (decision.market_view or "")[:200],
                         "actions": len([a for a in decision.actions if a.kind != "hold"])}
        acted = False
        loss_exits: List[Tuple[Action, str]] = []
        for a in decision.actions:
            if a.kind == "hold" or a.kind in RISK_ADDING:
                continue
            verdict = self.risk.evaluate(a, snap, cycle_start_ts, funding, regime, market)
            if not verdict.approved:
                self.notify.send(f"REJECTED (manager) {a.kind} {a.coin or a.outcome or ''}: {verdict.reason}", "warning")
                self.state.record_order(cycle_id, a.model_dump(), False, "manager: " + verdict.reason, {})
                continue
            if l.verify_loss_exits and self._is_loss_exit(verdict.action, snap):
                loss_exits.append((verdict.action, verdict.reason))
                continue
            self._exec_managed(verdict.action, "manager: " + verdict.reason, cycle_id, prices)
            acted = True
        if loss_exits:
            approved_ix, vetoed_ix = self.brain.verify(msg, [act for act, _ in loss_exits], decision.market_view)
            if self.brain.last_verify_failed:                  # fail-open: never trap a losing position behind an outage
                approved_ix = list(enumerate([act for act, _ in loss_exits]))
                vetoed_ix = []
                log.warning("verifier unavailable - manager loss exits executed without review (fail-open)")
            for i, act in approved_ix:
                self._exec_managed(act, "manager: " + loss_exits[i][1] + " | verifier approved loss exit", cycle_id, prices)
                acted = True
            for i, a, why in vetoed_ix:
                self.notify.send(f"REJECTED (manager) {a.kind} {a.coin or ''}: {why} (loss exit vetoed - position kept)", "warning")
                self.state.record_order(cycle_id, a.model_dump(), False, "manager loss exit vetoed: " + why, {})
        self._account_tokens()                                 # manager tokens booked now; propose() resets the counter later
        return acted

    def _useful_watch_levels(self, levels, snap: AccountSnapshot, ts: float) -> list:
        """MERGE the model's new levels into the active set (per coin+direction: newest wins) instead of wholesale
        replace - alarms on coins the model did not re-mention survive until hit or 24h expiry, so frequent looks
        cannot churn them into never firing. Levels within 0.2% of an existing stop/TP are dropped (those already
        fire automatically on the tick)."""
        taken = {}
        for p in snap.perps:
            taken.setdefault(p.coin, []).extend([x for x in (p.stop_px, p.tp_px) if x])
        fresh = []
        for w in levels[:6]:
            if any(abs(w.px - x) / x < 0.002 for x in taken.get(w.coin, []) if x):
                continue
            fresh.append(w.model_dump() | {"ts": ts})
        newkeys = {(w["coin"], w["direction"]) for w in fresh}
        ttl = self.cfg.llm.watch_level_ttl_hours * 3600
        kept = [w for w in (self.state.get("watch_levels") or [])
                if (w["coin"], w.get("direction")) not in newkeys and ts - (w.get("ts") or ts) < ttl]
        merged = (kept + fresh)[-8:]                       # oldest dropped past 8 total
        return merged

    def _place_resting(self, act: Action, reason: str, risk_usd: float, regime: str, view: str, cycle_id: int) -> None:
        """Park a gate/verifier/RR-approved limit entry; the 30s tick fills or expires it."""
        rest = [r for r in (self.state.get("resting_orders") or [])
                if not (r["action"].get("coin") == act.coin and r["action"].get("side") == act.side)]   # cancel-replace
        if len(rest) >= self.cfg.risk.max_resting_orders:
            self.state.record_order(cycle_id, act.model_dump(), False, f"max {self.cfg.risk.max_resting_orders} resting orders", {})
            self.notify.send(f"REJECTED limit {act.coin}: max {self.cfg.risk.max_resting_orders} resting orders", "warning")
            return
        rest.append({"action": act.model_dump(), "reason": reason, "risk_usd": risk_usd,
                     "regime": regime, "view": (view or "")[:200], "ts": time.time()})
        self.state.set("resting_orders", rest)
        self.state.record_order(cycle_id, act.model_dump(), True, reason + " | resting limit",
                                {"ok": True, "detail": f"resting limit {act.side} {act.coin} @ {act.limit_price}", "resting": True})
        self.notify.send(f"RESTING limit {act.side} {act.coin} ${act.size_usd:.0f} @ {act.limit_price} "
                         f"(ttl {self.cfg.risk.limit_order_ttl_min}m)", "info")

    def _check_resting(self, rest: list, mids: Dict[str, float], prices: Dict[str, float]) -> None:
        """30s tick: fill resting limits that price has touched; expire stale ones. Approval happened at placement;
        only structural facts (position cap) are re-checked at fill time."""
        keep = []
        ttl = self.cfg.risk.limit_order_ttl_min * 60
        cid = self.state.last_cycle_id()
        for r in rest:
            a = Action.model_validate(r["action"])
            px = mids.get(a.coin)
            if time.time() - r["ts"] > ttl:
                self.state.record_order(cid, a.model_dump(), True, "limit expired unfilled - canceled",
                                        {"ok": False, "detail": f"expired after {self.cfg.risk.limit_order_ttl_min}m unfilled"})
                self.notify.send(f"CANCELED limit {a.side} {a.coin} @ {a.limit_price}: unfilled for {self.cfg.risk.limit_order_ttl_min}m", "info")
                continue
            hit = px and ((a.side == "long" and px <= a.limit_price) or (a.side == "short" and px >= a.limit_price))
            if not hit:
                keep.append(r)
                continue
            snap = self.snapshot(prices)
            if len(snap.perps) >= self.cfg.risk.max_open_positions and a.coin not in {p.coin for p in snap.perps}:
                self.state.record_order(cid, a.model_dump(), True, "limit canceled at trigger: position cap reached",
                                        {"ok": False, "detail": "position cap reached before fill"})
                self.notify.send(f"CANCELED limit {a.coin}: position cap reached before fill", "warning")
                continue
            res = self.venues["hl"].execute(a, {**prices, a.coin: px})
            self.state.record_order(cid, a.model_dump(), True, r["reason"] + " | limit filled", res.model_dump())
            self.notify.send(f"{'FILLED' if res.ok else 'FAILED'} limit {a.side} {a.coin} ${a.size_usd or 0:.0f} @ {a.limit_price}: {res.detail}",
                             "info" if res.ok else "error")
            if res.ok:
                self.learner.record_open(self.trade_key(a), a, r.get("risk_usd") or 0.0, r.get("regime") or "",
                                         (res.raw or {}).get("fill_px") or a.limit_price, r.get("view") or "")
        self.state.set("resting_orders", keep)

    def _manage_due(self, snap: AccountSnapshot, perps_md: Dict, now: float) -> str:
        """Why the position manager should look now ('' = nothing). Shared by the 30s tick and the cycle."""
        l = self.cfg.llm
        last_ts = self.state.get("last_manage_ts") or 0
        last_px = self.state.get("last_manage_prices") or {}
        if now - last_ts >= l.manager_interval_min * 60:
            return f"interval {l.manager_interval_min}m"
        for p in snap.perps:
            if p.stop_px is None:
                return f"{p.coin} unprotected"
            atr15 = (perps_md.get(p.coin) or {}).get("atr14_15m_pct") or (perps_md.get(p.coin) or {}).get("atr14_1h_pct") or 1.0
            ref = last_px.get(p.coin)
            if ref and abs(p.mark_px / ref - 1) * 100 >= atr15 * l.manager_min_move_atr15:
                return f"{p.coin} moved {abs(p.mark_px / ref - 1) * 100:.2f}%"
            # near-level is ONE-SHOT per (coin, stop, tp): the level executes deterministically on the tick anyway,
            # so the manager looks once per level - re-armed only when the stop/TP changes. Without this, a tight
            # trailing stop keeps the position permanently "near" and burns a manager call every cycle.
            seen = self.state.get("manage_seen_levels") or {}
            key = f"{p.stop_px}|{p.tp_px}"
            for lvl in (p.stop_px, p.tp_px):
                if lvl and abs(p.mark_px - lvl) / p.mark_px * 100 < l.near_level_pct and seen.get(p.coin) != key:
                    return f"{p.coin} near stop/TP"
        last_upnl = self.state.get("last_manage_upnl")
        upnl = sum(p.unrealized_pnl for p in snap.perps)
        if last_upnl is not None and snap.equity_usd and abs(upnl - last_upnl) >= snap.equity_usd * l.manager_min_upnl_swing_pct / 100:
            return f"uPnL swing ${upnl - last_upnl:+.2f}"
        return ""

    def _exec_managed(self, act: Action, reason: str, cycle_id: int, prices: Dict[str, float]) -> None:
        venue = self.venues["pm"] if act.kind in PM_KINDS else self.venues["hl"]
        res: ExecResult = venue.execute(act, prices)
        self.state.record_order(cycle_id, act.model_dump(), True, reason, res.model_dump())
        self.notify.send(f"{'FILLED' if res.ok else 'FAILED'} {act.kind} {act.coin or act.outcome or ''}: {res.detail}  [{reason}]",
                         "info" if res.ok else "error")
        if res.ok and res.raw and "realized_pnl" in res.raw:
            lesson = self.learner.record_close(self.trade_key(act), float(res.raw["realized_pnl"]), (res.raw or {}).get("fill_px"), "manager close")
            if lesson:
                log.info(lesson)

    def _quiet_reason(self, snap: AccountSnapshot, prices: Dict[str, float], market: Optional[Dict] = None) -> str:
        """Non-empty string => skip the LLM this cycle. Adaptive: an attention score built from free market data
        decides whether anything is worth a (paid) look; the maximum quiet interval shrinks with volatility."""
        l = self.cfg.llm
        market = market or {}
        if not l.skip_if_quiet:
            return ""
        if getattr(self, "_wake", "").startswith("watch level"):
            return ""                                      # the model asked to be woken at this price - let it look
        # hard triggers: unprotected position or a position near its stop/TP.
        # With the position-manager brain enabled these are ITS wake conditions - the full entry agent stays asleep.
        if not l.manager_enabled:
            for p in snap.perps:
                if p.stop_px is None:
                    return ""
                for lvl in (p.stop_px, p.tp_px):
                    if lvl and abs(p.mark_px - lvl) / p.mark_px * 100 < l.near_level_pct:
                        return ""
        today = self.state.get("tokens_today") or {}
        if today.get("day") == time.strftime("%Y-%m-%d", time.gmtime()):
            if today.get("calls", 0) >= l.max_calls_per_day:
                return f"daily LLM call budget reached ({today['calls']}/{l.max_calls_per_day}) - flat, waiting for next UTC day"
            if today.get("cost_usd", 0.0) >= l.max_usd_per_day:
                return f"daily LLM spend cap reached (${today['cost_usd']:.2f}/${l.max_usd_per_day:.2f}) - only stop/TP proximity triggers a call until next UTC day"
        last_ts = self.state.get("last_llm_ts") or 0
        last_px = self.state.get("last_llm_prices") or {}
        last_sig = self.state.get("last_llm_signals") or {}
        last_upnl = self.state.get("last_llm_upnl")
        if not last_px:
            return ""
        perps = market.get("perps", {})
        held = {p.coin for p in snap.perps}

        # 1) price move since the last look, normalised by each coin's OWN 1h ATR (half an hourly range inside a
        #    cycle is an event; the same % on a 3%-ATR memecoin is noise). PM tokens wake via _pm_due, not here.
        def _bar(c: str) -> float:
            atr_c = (perps.get(c) or {}).get("atr14_1h_pct")
            return max(atr_c * l.move_atr_fraction, 0.05) if atr_c else l.quiet_move_pct
        moves = {c: abs(prices[c] / last_px[c] - 1) * 100 / _bar(c) for c in last_px if c in prices and last_px[c] and c in perps}
        top = max(moves, key=moves.get) if moves else None
        s_move = moves[top] if top else 0.0
        # 2) signal digest flips (trend / RSI band / MACD sign / funding flag) - a flip on a held coin counts fully
        flips = [c for c in perps if last_sig.get(c) is not None and perps[c].get("_key") != last_sig.get(c)]
        s_sig = min(sum(1.0 if c in held else 0.25 for c in flips), 1.5)   # capped: a market-wide tick is not 10 events
        # 3) volume surge anywhere
        s_vol = 0.5 if any((v.get("vol_ratio_24h") or 0) >= 2.0 for v in perps.values()) else 0.0
        # 3b) wake-ups: a coin whose last-3h ATR is >= wakeup_expansion x its 14h ATR - one shot per coin, re-armed only if
        #     expansion keeps rising past what the model already saw
        seen_exp = self.state.get("seen_expansion") or {}
        waking = [c for c, v in perps.items() if (v.get("vol_expansion") or 0) >= l.wakeup_expansion
                  and (v.get("vol_expansion") or 0) > seen_exp.get(c, 0) + 0.1]
        if waking:   # a genuine volatility wake-up overrides the hold-streak throttle: always look
            log.info(f"[dim]attention: wake-up {waking[:4]} (3h/14h ATR expansion >= {l.wakeup_expansion}) -> CALL[/]")
            return ""
        s_wake = 0.0
        # 4) unrealized PnL swing since the last look (1% of equity = 1.0)
        upnl = sum(p.unrealized_pnl for p in snap.perps)
        s_pnl = abs(upnl - last_upnl) / max(snap.equity_usd, 1) / 0.01 if last_upnl is not None else 0.0
        score = s_move + s_sig + s_vol + s_pnl + s_wake

        # volatility-scaled maximum quiet interval, stretched by the hold streak (model kept saying HOLD -> ask less)
        atr = (perps.get("BTC") or {}).get("atr14_1h_pct") or l.vol_low_atr_pct
        v = min(max((atr - l.vol_low_atr_pct) / max(l.vol_high_atr_pct - l.vol_low_atr_pct, 1e-9), 0.0), 1.0)
        if self._pm_due(snap, prices):
            return ""                                 # prediction-market cadence forces a look (own timer)
        streak = int(self.state.get("hold_streak") or 0)
        mult = min(1.0 + l.hold_streak_step * streak, l.hold_streak_max_mult)
        h_now = time.gmtime().tm_hour
        if l.dead_hours and l.dead_hours[0] <= h_now < l.dead_hours[1]:
            mult *= l.dead_hour_mult                       # dead window: demand a bigger reason to wake the model
        threshold = l.attention_threshold * mult
        dyn_max_min = (l.quiet_max_minutes - (l.quiet_max_minutes - l.quiet_min_minutes) * v) * min(mult, 2.0)
        elapsed_min = (time.time() - last_ts) / 60
        detail = (f"move {s_move:.2f}xATR {top or ''} | flips {len(flips)} {flips[:4]} | vol {s_vol:.1f} | wake {waking[:4]} | pnl-swing {s_pnl:.2f} | "
                  f"elapsed {elapsed_min:.0f}m of max {dyn_max_min:.0f}m (BTC ATR {atr:.2f}%)")
        if elapsed_min >= dyn_max_min:
            log.info(f"[dim]attention: forced look - {detail}[/]")
            return ""                               # forced periodic look (interval depends on volatility)
        if score >= threshold - 0.005:            # ties within display precision count as a hit
            log.info(f"[dim]attention {score:.3f} >= {threshold:.3f} (hold streak {streak}) -> CALL ({detail})[/]")
            return ""
        return (f"attention {score:.3f} < {threshold:.3f} [hold streak {streak}] (move {s_move:.2f}xATR {top or ''} | flips {len(flips)} | vol {s_vol:.1f} | "
                f"pnl-swing {s_pnl:.2f}); next forced look in {dyn_max_min - elapsed_min:.0f}m (BTC ATR {atr:.2f}% -> max quiet {dyn_max_min:.0f}m)")

    def _cost_usd(self, model: str, u) -> float:
        pin, pout = (self.cfg.llm.prices.get(model) or [1.0, 5.0])[:2]
        return (u.input * pin + u.cache_read * pin * 0.1 + u.output * pout) / 1e6

    def _account_tokens(self) -> None:
        u = self.brain.last_usage
        cost = sum(self._cost_usd(m, cu) for m, cu in self.brain.last_calls)
        day = time.strftime("%Y-%m-%d", time.gmtime())
        empty = {"day": day, "input": 0, "output": 0, "cache_read": 0, "calls": 0, "cost_usd": 0.0}
        tot = self.state.get("tokens_total") or dict(empty)
        today = self.state.get("tokens_today") or dict(empty)
        if today.get("day") != day:
            today = dict(empty)
        for d in (tot, today):
            d["input"] += u["input"]; d["output"] += u["output"]; d["cache_read"] += u["cache_read"]
            d["calls"] += len(self.brain.last_calls); d["cost_usd"] = round(d.get("cost_usd", 0.0) + cost, 5)
        self.state.set("tokens_total", tot)
        self.state.set("tokens_today", today)
        rtoday = (self.state.get("research_today") or {}).get("usd", 0.0)
        log.info(f"[dim]llm: {len(self.brain.last_calls)} call(s) in={u['input']} out={u['output']} ${cost:.4f}  today: decisions ${today['cost_usd']:.3f}/{self.cfg.llm.max_usd_per_day:.2f} + research ${rtoday:.3f}/{self.cfg.universe.prediction_markets.research_max_usd_per_day:.2f}[/]")

    def trade_key(self, a: Action) -> str:
        return a.token_id if a.kind in PM_KINDS else (a.coin or "")

    # -------------------------------------------------------------------- cycle
    def cycle(self) -> None:
        self._wake = self.state.get("wake_reason") or ""   # why this cycle ran ('' = heartbeat); journaled with the cycle
        self._managed = None                               # set when the position manager runs this cycle
        if self._wake:
            self.state.set("wake_reason", "")
        last_snap = (self.state.get("live_snapshot") or {}).get("snapshot") or {}
        held_coins = {p.get("coin") for p in last_snap.get("perps", []) if p.get("coin")}
        market = self.md.gather(fast_extra=held_coins)
        self._last_market = market                       # cached indicators for the 30s sensor tick
        prices: Dict[str, float] = market.pop("_prices")
        pm_tokens: Dict[str, str] = market.pop("_pm_tokens", {})
        for v in self.unique_venues:                      # let venues label PM positions with the real question / end time
            setattr(v, "pm_questions", self.md.pm_questions)
            setattr(v, "pm_meta", self.md.pm_meta)
        regime = regime_tag(market)

        self._housekeep(prices)
        self._autoprotect_pm(prices)                      # give held PM positions default stop/target if the model left them unset
        snap = self.snapshot(prices)
        self.state.set("live_snapshot", {"ts": time.time(), "equity": snap.equity_usd, "snapshot": snap.model_dump()})  # fresh before the slow LLM step
        pm_due = self._pm_due(snap, prices)               # prediction markets on their own cadence, separate from perps
        if not pm_due:
            market["prediction_markets"] = []            # perps cycle: no PM data in the (paid) prompt
        if not self.state.get("starting_equity"):
            self.state.set("starting_equity", snap.equity_usd)
            self.state.set("start_ts", time.time())
            self.notify.send(f"Starting equity recorded: ${snap.equity_usd:,.2f}")
        self.risk.roll_day(snap)

        kill = self.risk.check_kill(snap)
        if kill:
            self.flatten_and_die(kill, prices)

        cycle_start_ts = time.time()
        cycle_id = self.state.start_cycle(snap.equity_usd, snap.model_dump(), market)
        self._current_cycle = cycle_id
        funding = {c: (v.get("funding_8h_pct") or 0.0) for c, v in market.get("perps", {}).items()}
        self._close_stale(snap, prices, cycle_id)
        snap = self.snapshot(prices)
        # -------- 2nd brain: position manager (cheap, fast cadence, runs even on quiet cycles) --------
        if self._manage_positions(snap, prices, market, cycle_id, cycle_start_ts, funding, regime):
            snap = self.snapshot(prices)                     # manager closed/changed something

        # ---- bucket scheduling + quiet gate: don't pay for an LLM call when there is nothing to decide ------
        shown = self._select_shown(snap, prices, market)
        quiet_reason = self._quiet_reason(snap, prices, market)
        if not quiet_reason and not shown:
            quiet_reason = "no coin due in any bucket"
        if not quiet_reason and pm_due:
            self.researcher.annotate(market.get("prediction_markets", []))   # research only when we will actually ask the model
        if quiet_reason:
            log.info(f"[dim]quiet - LLM call skipped ({quiet_reason})[/]")
            self.state.finish_cycle(cycle_id, "", {"skipped": quiet_reason, "actions": [], "wake": self._wake} | ({"managed": self._managed} if self._managed else {}))
            console.rule(f"[dim]equity ${snap.equity_usd:,.2f}  positions={snap.open_position_count}  (quiet)")
            return
        def _mark_llm_baselines():
            self.state.set("last_llm_ts", time.time())
            held_tokens = {p.token_id for p in snap.pm}
            self.state.set("last_llm_prices", {k: v for k, v in prices.items() if k in self.cfg.universe.perps or k in held_tokens})
            self.state.set("last_llm_signals", {c: v.get("_key") for c, v in market.get("perps", {}).items()})
            self.state.set("seen_expansion", {c: (v.get("vol_expansion") or 0) for c, v in market.get("perps", {}).items()})
            self.state.set("last_llm_upnl", sum(p.unrealized_pnl for p in snap.perps))

        history = self.state.recent_history_text(self.cfg.llm.history_cycles) + "\n\n## LEARNER (your realized performance by setup)\n" + self.learner.lessons_text()
        # the paid prompt only carries coins that are due this cycle (bucket schedule); gates/regime use everything
        market_prompt = dict(market)
        market_prompt["perps"] = {c: {**market["perps"][c], "bucket": b.replace("+waking", ""), **({"waking_up": True} if b.endswith("+waking") or (market["perps"][c].get("vol_expansion") or 0) >= self.cfg.llm.wakeup_expansion else {})}
                                  for c, b in shown.items() if c in market.get("perps", {})}
        market_prompt["not_shown"] = f"{len(market.get('perps', {})) - len(shown)} other coins not due this cycle"
        perps_all = market.get("perps", {})
        ups = [c for c, v in perps_all.items() if v.get("ema20_above_ema50") is True and v.get("above_sma50_1h")]
        downs = [c for c, v in perps_all.items() if v.get("ema20_above_ema50") is False and not v.get("above_sma50_1h")]
        downs.sort(key=lambda c: (perps_all[c].get("chg_24h_pct") or 0))
        ups.sort(key=lambda c: -(perps_all[c].get("chg_24h_pct") or 0))
        market_prompt["direction"] = {"uptrends": len(ups), "downtrends": len(downs), "mixed": len(perps_all) - len(ups) - len(downs),
                                      "strongest_up": ups[:3], "strongest_down": downs[:3]}
        h_utc = time.gmtime().tm_hour
        sess = "asia" if h_utc < 7 else "europe" if h_utc < 13 else "us" if h_utc < 21 else "late"
        market_prompt["session"] = {"utc_hour": h_utc, "session": sess}
        self._mark_shown(shown, prices, market)
        if pm_due:
            self.state.set("last_pm_ts", time.time())
            self.state.set("last_pm_prices_seen", {q.token_id: q.cur_price for q in snap.pm})
        log.info(f"[dim]showing {len(shown)}/{len(market.get('perps', {}))} coins: {', '.join(f'{c}({b[:3]})' for c, b in shown.items())}[/]")
        user_msg = build_user_message(self.cfg, snap, market_prompt, history, self.state.get("starting_equity"), self.state.get("start_ts"),
                                      limits=self._limits_now(snap, market))

        try:
            decision, raw = self.brain.propose(user_msg)
        except Exception as e:
            log.exception("LLM call failed")
            self.state.finish_cycle(cycle_id, "", {"wake": self._wake} | ({"managed": self._managed} if self._managed else {}), error=str(e))
            return

        if decision.market_view != "(proposer failed)":
            _mark_llm_baselines()                    # reset the attention clock only when the model actually answered
        log.info(f"[bold]view:[/] {decision.market_view}")
        if decision.watch_levels:
            self.state.set("watch_levels", self._useful_watch_levels(decision.watch_levels, snap, time.time()))
        if decision.notes:
            log.info(f"[dim]notes: {decision.notes}[/]")

        def _reject(a: Action, why: str, by: str) -> None:
            self.notify.send(f"REJECTED {a.kind} {a.coin or a.outcome or ''}{(' $%.0f' % a.size_usd) if a.size_usd else ''}: {why}", "warning")
            self.state.record_order(cycle_id, a.model_dump(), False, why, {})
            self.learner.record_veto(a, prices.get(a.coin) if a.coin else None, why, by)   # shadow-simulate to score the rejecter

        def _execute(act: Action, reason: str, risk_usd: float) -> None:
            if act.kind == "open_perp" and act.order_type == "limit" and act.limit_price:
                mark = prices.get(act.coin)
                if mark and ((act.side == "long" and act.limit_price < mark) or (act.side == "short" and act.limit_price > mark)):
                    self._place_resting(act, reason, risk_usd, regime, decision.market_view, cycle_id)
                    return
                act = act.model_copy()
                act.order_type = None                     # already marketable - just fill at market now
            venue = self.venues["pm"] if act.kind in PM_KINDS else self.venues["hl"]
            res: ExecResult = venue.execute(act, prices)
            self.state.record_order(cycle_id, act.model_dump(), True, reason, res.model_dump())
            self.notify.send(f"{'FILLED' if res.ok else 'FAILED'} {act.kind} {act.coin or act.outcome or ''} ${act.size_usd or ''}: {res.detail}  [{reason}]",
                             "info" if res.ok else "error")
            if res.ok:
                key = self.trade_key(act)
                if act.kind in RISK_ADDING:
                    self.learner.record_open(key, act, risk_usd, regime, (res.raw or {}).get("fill_px") or prices.get(act.coin or ""), decision.market_view)
                elif res.raw and "realized_pnl" in res.raw:
                    lesson = self.learner.record_close(key, float(res.raw["realized_pnl"]), (res.raw or {}).get("fill_px"), "agent close")
                    if lesson:
                        log.info(lesson)

        proposed_any = False
        pending: List[Tuple[Action, str]] = []      # gate-approved risk-adding actions awaiting the verifier
        loss_exits: List[Tuple[Action, str]] = []   # loss-realising exits awaiting the verifier (executed anyway if it is down)
        for a in decision.actions:
            if a.kind == "hold":
                log.info(f"HOLD - {a.reason}")
                continue
            if a.kind in PM_KINDS and a.token_id:
                if a.token_id in pm_tokens:
                    a.token_id = pm_tokens[a.token_id]          # T3 -> real 77-digit token id
                elif a.token_id not in prices and not any(p.token_id == a.token_id for p in snap.pm):
                    self.notify.send(f"REJECTED {a.kind}: unknown prediction-market token code {a.token_id!r}", "warning")
                    self.state.record_order(cycle_id, a.model_dump(), False, f"unknown token code {a.token_id}", {})
                    continue
            snap = self.snapshot(prices)
            verdict = self.risk.evaluate(a, snap, cycle_start_ts, funding, regime, market)   # free, deterministic - runs FIRST
            proposed_any = True                      # any non-hold action resets the hold streak (as documented)
            if a.kind in RISK_ADDING:
                if not verdict.approved:
                    _reject(a, verdict.reason, "risk_gate")
                    continue
                pending.append((verdict.action, verdict.reason))
                continue
            # risk-reducing actions (close / tighten stop / sell) execute immediately - rotations close first.
            # Exception: exits that REALISE A LOSS are a judgement call -> reviewed by the verifier (fail-open).
            if not verdict.approved:
                _reject(a, verdict.reason, "risk_gate")
                continue
            if self.cfg.llm.verify_loss_exits and self._is_loss_exit(verdict.action, snap):
                loss_exits.append((verdict.action, verdict.reason))
                continue
            _execute(verdict.action, verdict.reason, 0.0)

        # verifier only sees what the gate let through (adds to a held same-side position skip it).
        # INDEX-keyed end to end: indices < n_pending are entries, >= n_pending are loss exits.
        held = {(p.coin, "long" if p.size > 0 else "short") for p in snap.perps}
        to_verify = [act for act, _ in pending] + [act for act, _ in loss_exits]
        n_pending = len(pending)
        approved_ix, vetoed_ix = self.brain.verify(user_msg, to_verify, decision.market_view, held) if to_verify else ([], [])
        if loss_exits and self.brain.last_verify_failed:           # fail-open: never trap a losing position behind an outage
            done = {i for i, _ in approved_ix}
            approved_ix = list(approved_ix) + [(n_pending + k, act) for k, (act, _) in enumerate(loss_exits) if n_pending + k not in done]
            vetoed_ix = [(i, a, w) for i, a, w in vetoed_ix if i < n_pending]
            log.warning("verifier unavailable - loss exits executed without review (fail-open)")
        approved = []
        vetoed = []
        for i, act in approved_ix:
            if i >= n_pending:                                     # verifier-approved loss exit: execute as an exit now
                _execute(act, loss_exits[i - n_pending][1] + " | verifier approved loss exit", 0.0)
            else:
                approved.append(act)
        for i, a, why in vetoed_ix:
            vetoed.append((a, f"{why} (loss exit vetoed - position kept)") if i >= n_pending else (a, why))
        reasons = {id(act): why for act, why in pending}
        for a, why in vetoed:
            _reject(a, why, "verifier")
        for act in approved:
            snap = self.snapshot(prices)                                   # re-check caps after earlier fills this cycle
            recheck = self.risk.evaluate(act, snap, cycle_start_ts, funding, regime, market)
            if not recheck.approved:
                _reject(act, recheck.reason, "risk_gate")
                continue
            act = recheck.action
            reason = recheck.reason
            entry_ref = act.limit_price if (act.kind == "open_perp" and act.order_type == "limit" and act.limit_price) \
                else (prices.get(act.coin) if act.coin else None)
            if act.kind == "open_perp":
                ok, why = self.risk.validate_stop_vs_entry(act, entry_ref)
                if not ok:
                    _reject(act, why, "risk_gate")
                    continue
            # event PM with an implausibly large research edge: don't reject outright - re-verify the facts first
            if act.kind == "pm_buy":
                from .market_data import parse_price_market
                meta = self.md.pm_meta.get(str(act.market_id), {})
                pmc = self.cfg.universe.prediction_markets
                edge = (act.confidence or 0) - (act.limit_price or 0)
                is_swing = act.stop_loss_px is not None and act.take_profit_px is not None
                if meta and not is_swing and not parse_price_market(meta.get("question", "")) and edge > pmc.max_research_edge:
                    v = self.researcher.verify(meta, act.confidence, act.outcome or "Yes")
                    if v and v.get("agree") and v.get("verified_outcome") and (v["prob_yes"] - (act.limit_price or 0)) > pmc.max_research_edge and v.get("confidence", 0) >= 0.7:
                        # confirmed by a second skeptical search -> take it, but size conservatively (cap the edge used)
                        act = act.model_copy(); act.confidence = round((act.limit_price or 0) + pmc.max_research_edge, 3)
                        self.notify.send(f"EDGE VERIFIED {act.outcome}: 2nd search confirms outcome+prob ({v['summary'][:60]}) - taking, sized on capped edge", "warning")
                    else:
                        vs = (v or {}).get("summary", "no result")
                        _reject(act, f"implausible edge {edge:+.2f} NOT confirmed on re-check (outcome/price unverified): {vs[:70]}", "rr_model")
                        continue
            mult = self.learner.size_multiplier(act, regime) * self._throttle_mult()
            rrv = self.rr.assess(act, snap, entry_ref, mult, self.md.pm_meta, {c: v.get("mark") for c, v in market.get("perps", {}).items()})
            if not rrv.ok:
                _reject(act, f"{reason} | rr: {rrv.reason}", "rr_model")
                continue
            _execute(rrv.action, f"{reason} | rr: {rrv.reason}", rrv.risk_usd)

        self._account_tokens()
        self.state.set("hold_streak", 0 if proposed_any else int(self.state.get("hold_streak") or 0) + 1)

        self.state.finish_cycle(cycle_id, raw, decision.model_dump() | {"wake": self._wake} | ({"managed": self._managed} if self._managed else {}))
        snap = self.snapshot(prices)
        self.state.update_snapshot(cycle_id, snap.equity_usd, snap.model_dump())   # post-trade state -> dashboard sees fills now
        start = self.state.get("starting_equity") or snap.equity_usd
        console.rule(f"[bold]equity ${snap.equity_usd:,.2f}  ({snap.equity_usd/start:.3f}x)  positions={snap.open_position_count}  mode={self.cfg.mode}")

    def _watch_files(self) -> Dict[str, float]:
        out = {}
        for f in (ROOT / "config.yaml", DATA_DIR / "secrets.env"):
            try:
                out[str(f)] = f.stat().st_mtime
            except FileNotFoundError:
                out[str(f)] = 0.0
        return out

    def _restart_if_changed(self, baseline: Dict[str, float]) -> None:
        """Config or secrets edited (admin UI / scp) or RESTART file present -> exit; Docker/systemd restarts us with the new config."""
        restart = DATA_DIR / "RESTART"
        reason = ""
        if restart.exists():
            reason = restart.read_text().strip() or "restart requested"
            restart.unlink()
        elif self._watch_files() != baseline:
            reason = "config.yaml / secrets changed"
        if reason:
            self.notify.send(f"restarting to apply: {reason}", "warning")
            self.state.set("last_reload_ts", time.time())
            sys.exit(3)

    # --------------------------------------------------------------------- run
    def run(self, once: bool = False) -> None:
        cfg = self.cfg
        baseline = self._watch_files()
        (DATA_DIR / "RESTART").unlink(missing_ok=True)
        banner = (
            f"trading-agent starting | mode={cfg.mode.upper()} | llm={self.brain.describe()} | interval={cfg.loop_interval_seconds}s\n"
            f"goal: {cfg.goal.target_multiple}x in {cfg.goal.horizon_days}d | risk: lev<={cfg.risk.max_leverage}x pos<={cfg.risk.max_position_pct_equity}% "
            f"daily-loss<={cfg.risk.max_daily_loss_pct}% drawdown-kill={cfg.risk.max_drawdown_pct}%"
        )
        if cfg.is_live:
            banner += "\n*** LIVE MODE - REAL FUNDS ***"
        self.notify.send(banner, "warning" if cfg.is_live else "info")
        if self.state.get("killed"):
            self.notify.send(f"Agent was previously killed: {self.state.get('killed')}. Delete data/KILL and clear 'killed' in journal to restart.", "error")
            sys.exit(2)
        while True:
            self._current_cycle = None
            try:
                self.cycle()
            except SystemExit:
                raise
            except Exception as e:
                log.exception("cycle error")
                if self._current_cycle:      # make the failure visible in the journal / dashboard
                    try:
                        self.state.finish_cycle(self._current_cycle, "", {"market_view": "(cycle error)", "actions": []}, error=f"{type(e).__name__}: {e}"[:300])
                    except Exception:
                        pass
            if once:
                return
            # EVENT-DRIVEN: kill-file check every 5s; 30s sensor tick (stops, watch levels, wake triggers).
            # A wake runs the next decision cycle immediately; otherwise the heartbeat (loop_interval_seconds)
            # refreshes indicators with a free gather - the quiet gate still decides whether the LLM is called.
            last_cycle_end = time.time()
            tick_every = max(cfg.llm.tick_seconds // 5, 1)
            for i in range(cfg.loop_interval_seconds // 5):
                if KILL_FILE.exists():
                    self.flatten_and_die("manual kill file", self.md.all_mids())
                self._restart_if_changed(baseline)
                if i and i % tick_every == 0:
                    wake = ""
                    try:
                        wake = self.tick()
                    except SystemExit:
                        raise
                    except Exception:
                        log.exception("tick error")
                    if wake and time.time() - last_cycle_end >= cfg.llm.min_cycle_gap_seconds:
                        log.info(f"[bold]wake[/] {wake}")
                        self.state.set("wake_reason", wake)
                        break
                time.sleep(5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="run a single cycle and exit")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config)
    cfg.validate_runtime()
    Agent(cfg).run(once=args.once)


if __name__ == "__main__":
    main()
