"""
Online reinforcement learner (contextual bandit over the agent's own trades) + two feedback loops:

  * context  = (product | coin | side | confidence-bucket | regime)   Q(ctx) <- Q + alpha*(R - Q)
  * post-mortems: after every close a cheap model writes a 2-line "expected vs happened" lesson; the
    last N are shown to the proposer (a reason is something a model can act on; a number is not).
  * shadow vetoes: trades the verifier rejected are paper-simulated with their own stop/TP so the
    verifier itself gets a score (is it blocking winners or losers?).

Until a context has `min_samples` closes it stays at multiplier 1.0 (pure exploration).
"""
from __future__ import annotations

import json
import time
from typing import Dict, List, Optional

from .config import Config
from .models import Action
from .notify import log
from .state import State


def _conf_bucket(c: float) -> str:
    return "hi" if c >= 0.7 else "mid" if c >= 0.55 else "lo"


def regime_tag(market: Dict) -> str:
    """trend from BTC EMA/SMA structure + volatility bucket from BTC ATR%. e.g. 'up-midvol'."""
    btc = market.get("perps", {}).get("BTC", {})
    if btc.get("ema20_above_ema50") is True and btc.get("above_sma50_1h"):
        trend = "up"
    elif btc.get("ema20_above_ema50") is False and not btc.get("above_sma50_1h"):
        trend = "down"
    else:
        trend = "chop"
    atr = btc.get("atr14_1h_pct") or 0
    vol = "lowvol" if atr < 0.5 else "midvol" if atr < 1.2 else "hivol"
    return f"{trend}-{vol}"


def context_key(a: Action, regime: str = "") -> str:
    if a.kind == "open_perp":
        return f"perp|{a.coin}|{a.side}|{_conf_bucket(a.confidence)}|{regime}"
    if a.kind == "pm_buy":
        band = "fav" if (a.limit_price or 0) >= 0.6 else "dog" if (a.limit_price or 0) <= 0.4 else "even"
        mode = "swing" if (a.stop_loss_px is not None and a.take_profit_px is not None) else "hold"
        return f"pm-{mode}|{band}|{_conf_bucket(a.confidence)}"
    if a.kind == "spot_buy":
        return f"spot|{a.coin}|{_conf_bucket(a.confidence)}"
    return f"{a.kind}"


class Learner:
    def __init__(self, cfg: Config, state: State, notes_provider=None):
        self.cfg = cfg
        self.l = cfg.learner
        self.state = state
        self.notes = notes_provider                                   # cheap LLM for post-mortems (optional)
        self.q: Dict[str, Dict] = state.get("learner_q", {})          # ctx -> {q, n, wins, total_r, total_pnl}
        self.open: Dict[str, Dict] = state.get("learner_open", {})    # trade_key -> {ctx, risk_usd, ts, ...}
        self.postmortems: List[Dict] = state.get("postmortems", [])
        self.shadows: List[Dict] = state.get("shadow_trades", [])     # vetoed trades being simulated

    def _save(self) -> None:
        self.state.set("learner_q", self.q)
        self.state.set("learner_open", self.open)
        self.state.set("postmortems", self.postmortems[-50:])
        self.state.set("shadow_trades", self.shadows[-200:])

    # ------------------------------------------------------------------ lifecycle
    def record_open(self, trade_key: str, a: Action, risk_usd: float, regime: str = "", entry_px: Optional[float] = None,
                    market_view: str = "") -> None:
        if not self.l.enabled:
            return
        prev = self.open.get(trade_key)
        if prev:  # adding to a position: accumulate risk, keep original context
            prev["risk_usd"] += risk_usd
            prev["size_usd"] = prev.get("size_usd", 0) + (a.size_usd or 0)
        else:
            self.open[trade_key] = {
                "ctx": context_key(a, regime), "risk_usd": max(risk_usd, 1e-6), "ts": time.time(),
                "kind": a.kind, "coin": a.coin or a.outcome, "side": a.side, "size_usd": a.size_usd or 0,
                "entry_px": entry_px, "stop_px": a.stop_loss_px, "tp_px": a.take_profit_px,
                "confidence": a.confidence, "reason": (a.reason or "")[:300], "market_view": (market_view or "")[:300],
            }
        self._save()

    def record_close(self, trade_key: str, pnl_usd: float, exit_px: Optional[float] = None, why: str = "") -> Optional[str]:
        if not self.l.enabled or trade_key not in self.open:
            return None
        o = self.open.pop(trade_key)
        # trade-management state: consecutive-loss streak (equity-curve throttle) + re-entry cooldown marks
        st = self.state.get("exit_streak") or {"wins": 0, "losses": 0, "ts": 0}
        if pnl_usd > 0:
            st = {"wins": st.get("wins", 0) + 1, "losses": 0, "ts": time.time()}
        else:
            st = {"wins": 0, "losses": st.get("losses", 0) + 1, "ts": time.time()}
        self.state.set("exit_streak", st)
        if "stop" in (why or "").lower() and o.get("kind") == "open_perp" and o.get("side"):
            blocks = self.state.get("reentry_block") or {}
            blocks[f"{o.get('coin')}|{o.get('side')}"] = time.time()
            self.state.set("reentry_block", {k: v for k, v in blocks.items() if time.time() - v < 24 * 3600})
        r = max(min(pnl_usd / o["risk_usd"], 10.0), -3.0)
        q = self.q.setdefault(o["ctx"], {"q": 0.0, "n": 0, "wins": 0, "total_r": 0.0, "total_pnl": 0.0})
        q["q"] = q["q"] + self.l.alpha * (r - q["q"]) if q["n"] else r
        q["n"] += 1
        q["wins"] += int(pnl_usd > 0)
        q["total_r"] += r
        q["total_pnl"] += pnl_usd
        self._save()
        if self.l.postmortems and self.notes is not None:
            try:
                self._postmortem(o, pnl_usd, r, exit_px, why)
            except Exception as e:  # never let a lesson break trading
                log.warning(f"postmortem failed: {e}")
        return f"learner: {o['ctx']} closed R={r:+.2f} (pnl ${pnl_usd:+.2f}, {why}) -> Q={q['q']:+.2f} n={q['n']}"

    # ---------------------------------------------------------------- post-mortem
    def _postmortem(self, o: Dict, pnl: float, r: float, exit_px: Optional[float], why: str) -> None:
        held_h = (time.time() - o["ts"]) / 3600
        trade = {k: o.get(k) for k in ("kind", "coin", "side", "size_usd", "entry_px", "stop_px", "tp_px", "confidence", "reason", "market_view", "ctx")}
        trade.update({"exit_px": exit_px, "pnl_usd": round(pnl, 3), "R": round(r, 2), "held_hours": round(held_h, 1), "closed_by": why})
        system = ("You write brutally honest 2-line post-mortems for an autonomous trader. Line 1: what the thesis expected vs what "
                  "actually happened (numbers). Line 2: the single transferable lesson (what to do differently, or what worked). "
                  "No filler. Return JSON {\"lesson\": \"<2 lines>\"}.")
        c = self.notes.complete(system, json.dumps(trade, separators=(",", ":")), {"type": "object", "properties": {"lesson": {"type": "string"}}, "required": ["lesson"]}, "postmortem")
        try:      # post-mortems are LLM spend too - count them toward the daily budget
            pin, pout = (self.cfg.llm.prices.get(getattr(self.notes, "model", "")) or [0.3, 2.5])[:2]
            cost = (c.usage.input * pin + c.usage.output * pout) / 1e6
            day = time.strftime("%Y-%m-%d", time.gmtime())
            for key in ("tokens_today", "tokens_total"):
                t = self.state.get(key) or {"day": day, "input": 0, "output": 0, "cache_read": 0, "calls": 0, "cost_usd": 0.0}
                if key == "tokens_today" and t.get("day") != day:
                    t = {"day": day, "input": 0, "output": 0, "cache_read": 0, "calls": 0, "cost_usd": 0.0}
                t["input"] += c.usage.input; t["output"] += c.usage.output; t["calls"] = t.get("calls", 0) + 1
                t["cost_usd"] = round(t.get("cost_usd", 0.0) + cost, 5)
                self.state.set(key, t)
        except Exception:
            pass
        if c.data and c.data.get("lesson"):
            self.postmortems.append({"ts": time.time(), "coin": o.get("coin"), "side": o.get("side"), "R": round(r, 2),
                                     "pnl": round(pnl, 3), "closed_by": why, "lesson": c.data["lesson"][:400]})
            self._save()
            log.info(f"[dim]post-mortem {o.get('coin')}: {c.data['lesson'][:160]}[/]")

    # --------------------------------------------------------------- shadow vetoes
    def record_veto(self, a: Action, mark_px: Optional[float], reason: str, by: str = "verifier") -> None:
        """Any REJECTED open_perp (verifier veto, risk gate, RR model) becomes a shadow trade: would it have hit TP or stop?
        Resolved shadows score the rejecter - is it blocking winners or losers?"""
        if not (self.l.enabled and self.l.shadow_vetoes and a.kind == "open_perp" and mark_px and a.stop_loss_px and a.take_profit_px):
            return
        self.shadows.append({"ts": time.time(), "coin": a.coin, "side": a.side, "entry_px": mark_px, "stop_px": a.stop_loss_px,
                             "tp_px": a.take_profit_px, "size_usd": a.size_usd or 0, "confidence": a.confidence,
                             "reason": reason[:200], "by": by, "status": "open", "r": None})
        self._save()

    def update_shadows(self, prices: Dict[str, float]) -> List[str]:
        """Called every minute with live prices. Resolves shadow trades; returns event strings."""
        events: List[str] = []
        if not self.shadows:
            return events
        changed = False
        for s in self.shadows:
            if s["status"] != "open":
                continue
            px = prices.get(s["coin"])
            if not px:
                continue
            long = s["side"] == "long"
            risk = abs(s["entry_px"] - s["stop_px"]) or 1e-9
            s["mark_px"] = px                                  # live view for the dashboard
            s["live_r"] = round(((px - s["entry_px"]) if long else (s["entry_px"] - px)) / risk, 2)
            changed = True
            hit_stop = px <= s["stop_px"] if long else px >= s["stop_px"]
            hit_tp = px >= s["tp_px"] if long else px <= s["tp_px"]
            expired = time.time() - s["ts"] > self.l.shadow_expiry_hours * 3600
            if hit_stop:
                s["status"], s["r"] = "stopped", -1.0
            elif hit_tp:
                s["status"], s["r"] = "target", round(abs(s["tp_px"] - s["entry_px"]) / risk, 2)
            elif expired:
                s["status"], s["r"] = "expired", round(((px - s["entry_px"]) if long else (s["entry_px"] - px)) / risk, 2)
            else:
                continue
            changed = True
            events.append(f"shadow (vetoed) {s['side']} {s['coin']} -> {s['status']} R={s['r']:+.2f}")
        if changed:
            self._save()
        return events

    def _score(self, shadows: List[Dict], who: str) -> Dict:
        done = [s for s in shadows if s["status"] != "open"]
        open_n = len([s for s in shadows if s["status"] == "open"])
        if not done:
            return {"resolved": 0, "open": open_n}
        rs = [s["r"] for s in done]
        won = sum(1 for r in rs if r > 0)
        avg = sum(rs) / len(rs)
        verdict = (f"{who} is EARNING its keep (rejected trades lose on average)" if avg < -0.1 else
                   f"{who} may be TOO STRICT (rejected trades win on average)" if avg > 0.1 else f"{who}: rejected trades roughly break even")
        return {"resolved": len(done), "open": open_n, "vetoed_would_have_won": won, "vetoed_would_have_lost": len(done) - won,
                "avg_r_of_vetoed": round(avg, 2), "sum_r_saved": round(-sum(rs), 2), "verdict": verdict}

    def rejection_scores(self) -> Dict[str, Dict]:
        """Per rejecter (verifier / risk_gate / rr_model) plus 'all'."""
        out = {"all": self._score(self.shadows, "rejection layer")}
        for who in sorted({s.get("by", "verifier") for s in self.shadows}):
            out[who] = self._score([s for s in self.shadows if s.get("by", "verifier") == who], who)
        return out

    def verifier_score(self) -> Dict:
        return self._score([s for s in self.shadows if s.get("by", "verifier") == "verifier"], "verifier")

    # ----------------------------------------------------------------- outputs
    def size_multiplier(self, a: Action, regime: str = "") -> float:
        if not self.l.enabled:
            return 1.0
        q = self.q.get(context_key(a, regime))
        if not q or q["n"] < self.l.min_samples:
            return 1.0
        m = 0.6 + q["q"] * (0.7 if q["q"] <= 0 else 0.4)
        return round(min(max(m, self.l.min_multiplier), self.l.max_multiplier), 2)

    def lessons_text(self) -> str:
        parts: List[str] = []
        if not self.l.enabled:
            return "(learner disabled)"
        if not self.q:
            parts.append("(no closed trades yet - learner in exploration mode, all multipliers 1.0)")
        else:
            rows = sorted(self.q.items(), key=lambda kv: kv[1]["q"], reverse=True)
            total_n = sum(v["n"] for v in self.q.values())
            total_pnl = sum(v["total_pnl"] for v in self.q.values())
            wins = sum(v["wins"] for v in self.q.values())
            parts.append(f"Closed trades: {total_n}, win rate {wins/total_n*100:.0f}%, realized ${total_pnl:+.2f}")
            for ctx, v in rows[:12]:
                flag = "" if v["n"] >= self.l.min_samples else " (few samples)"
                parts.append(f"  {ctx}: Q={v['q']:+.2f}R n={v['n']} wr={v['wins']/v['n']*100:.0f}% avgR={v['total_r']/v['n']:+.2f}{flag}")
            bad = [c for c, v in self.q.items() if v["n"] >= self.l.min_samples and v["q"] < -0.3]
            good = [c for c, v in self.q.items() if v["n"] >= self.l.min_samples and v["q"] > 0.3]
            if bad:
                parts.append("AVOID (negative expectancy so far): " + ", ".join(bad))
            if good:
                parts.append("WORKING (positive expectancy so far): " + ", ".join(good))
        if self.postmortems:
            parts.append("RECENT POST-MORTEMS (newest last):")
            for pm in self.postmortems[-self.l.postmortems_shown:]:
                parts.append(f"  [{pm['coin']} {pm['side'] or ''} R={pm['R']:+.2f} {pm['closed_by']}] {pm['lesson']}")
        scores = self.rejection_scores()
        allsc = scores.get("all", {})
        if allsc.get("resolved"):
            parts.append(f"REJECTED-PROPOSAL OUTCOMES: of your last {allsc['resolved']} rejected trade ideas, {allsc['vetoed_would_have_won']} would have "
                         f"hit target and {allsc['vetoed_would_have_lost']} would have stopped out (avg {allsc['avg_r_of_vetoed']:+.2f}R). "
                         + ("Your ideas are sound - the limits are the constraint; keep proposing, size smaller." if allsc['avg_r_of_vetoed'] > 0.1 else
                            "The rejections were right - tighten your entry criteria." if allsc['avg_r_of_vetoed'] < -0.1 else "Neutral so far."))
            for who, sc in scores.items():
                if who != "all" and sc.get("resolved"):
                    parts.append(f"  {who}: {sc['resolved']} resolved, {sc['vetoed_would_have_won']} would have won, avg {sc['avg_r_of_vetoed']:+.2f}R - {sc['verdict']}")
        return "\n".join(parts)
