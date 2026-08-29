"""Performance analytics computed from the journal. Pure functions over sqlite rows; no side effects."""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, List

from .config import Config


def _j(s, default):
    try:
        return json.loads(s) if s else default
    except json.JSONDecodeError:
        return default


def _venue_of(kind: str) -> str:
    if kind in ("pm_buy", "pm_sell"):
        return "prediction_markets"
    if kind in ("spot_buy", "spot_sell"):
        return "spot"
    return "perps"


def closed_trades(c: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = c.execute("SELECT ts, cycle_id, action, risk_reason, result FROM orders WHERE approved=1 ORDER BY id").fetchall()
    out = []
    for r in rows:
        res = _j(r["result"], {})
        raw = (res or {}).get("raw") or {}
        if not res.get("ok") or "realized_pnl" not in raw:
            continue
        a = _j(r["action"], {})
        out.append({"ts": r["ts"], "cycle_id": r["cycle_id"], "kind": a.get("kind"), "venue": _venue_of(a.get("kind", "")),
                    "coin": a.get("coin") or raw.get("coin") or raw.get("token_id"), "pnl": float(raw["realized_pnl"]),
                    "closed_by": a.get("reason") if (r["risk_reason"] or "").startswith("auto") else "agent",
                    "detail": res.get("detail", "")[:160]})
    return out


def _drawdown(equities: List[float]) -> Dict[str, float]:
    peak = equities[0] if equities else 0
    max_dd = 0.0
    max_dd_pct = 0.0
    for e in equities:
        peak = max(peak, e)
        dd = peak - e
        if dd > max_dd:
            max_dd, max_dd_pct = dd, (dd / peak * 100 if peak else 0)
    return {"max_drawdown_usd": round(max_dd, 3), "max_drawdown_pct": round(max_dd_pct, 2)}


def compute(c: sqlite3.Connection, cfg: Config) -> Dict[str, Any]:
    meta = {k: _j(v, None) for k, v in c.execute("SELECT key, value FROM meta").fetchall()}
    eq_rows = c.execute("SELECT ts, equity FROM cycles ORDER BY id").fetchall()
    equities = [r["equity"] for r in eq_rows]
    start_eq = meta.get("starting_equity") or (equities[0] if equities else 0)
    start_ts = meta.get("start_ts") or (eq_rows[0]["ts"] if eq_rows else time.time())
    now_eq = equities[-1] if equities else start_eq
    days = max((time.time() - start_ts) / 86400, 1e-9)

    trades = closed_trades(c)
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)
    n = len(trades)

    by_venue: Dict[str, Dict[str, Any]] = {}
    for t in trades:
        v = by_venue.setdefault(t["venue"], {"trades": 0, "wins": 0, "pnl": 0.0})
        v["trades"] += 1
        v["wins"] += int(t["pnl"] > 0)
        v["pnl"] = round(v["pnl"] + t["pnl"], 3)
    by_coin: Dict[str, Dict[str, Any]] = {}
    for t in trades:
        v = by_coin.setdefault(str(t["coin"]), {"trades": 0, "wins": 0, "pnl": 0.0})
        v["trades"] += 1
        v["wins"] += int(t["pnl"] > 0)
        v["pnl"] = round(v["pnl"] + t["pnl"], 3)
    by_close = {}
    for t in trades:
        cb = (t["closed_by"] or "").lower()
        k = ("stop" if "stop" in cb else "take_profit" if "take-profit" in cb or "target" in cb else
             "resolved" if "resolved" in cb else "stale" if "stale" in cb else "agent")
        v = by_close.setdefault(k, {"trades": 0, "pnl": 0.0})
        v["trades"] += 1
        v["pnl"] = round(v["pnl"] + t["pnl"], 3)

    tokens_total = meta.get("tokens_total") or {}
    llm_cost = float(tokens_total.get("cost_usd") or 0)
    realized = sum(t["pnl"] for t in trades)
    unrealized = now_eq - start_eq - realized

    # activity from cycles
    cyc = c.execute("SELECT decision, error FROM cycles").fetchall()
    skipped = sum(1 for r in cyc if (_j(r["decision"], {}) or {}).get("skipped"))
    failed = sum(1 for r in cyc if r["error"] or (_j(r["decision"], {}) or {}).get("market_view") == "(proposer failed)")
    orders = c.execute("SELECT approved, risk_reason, action, result FROM orders").fetchall()
    proposed = sum(1 for o in orders if (_j(o["action"], {}) or {}).get("kind") in ("open_perp", "spot_buy", "pm_buy"))
    rejected = [o for o in orders if not o["approved"]]
    rej_by = {"verifier": 0, "risk_gate": 0, "rr_model": 0, "other": 0}
    for o in rejected:
        why = (o["risk_reason"] or "")
        if why.startswith("VERIFIER"):
            rej_by["verifier"] += 1
        elif "rr:" in why:
            rej_by["rr_model"] += 1
        elif why:
            rej_by["risk_gate"] += 1
        else:
            rej_by["other"] += 1

    # equity per UTC day
    daily: Dict[str, Dict[str, float]] = {}
    for r in eq_rows:
        d = time.strftime("%Y-%m-%d", time.gmtime(r["ts"]))
        day = daily.setdefault(d, {"open": r["equity"], "close": r["equity"], "low": r["equity"], "high": r["equity"]})
        day["close"] = r["equity"]
        day["low"] = min(day["low"], r["equity"])
        day["high"] = max(day["high"], r["equity"])

    return {
        "as_of": time.time(),
        "since_ts": start_ts,
        "days": round(days, 2),
        "equity": {"start": start_eq, "now": now_eq, "multiple": round(now_eq / start_eq, 4) if start_eq else None,
                   "pnl_total": round(now_eq - start_eq, 3), "realized": round(realized, 3), "unrealized": round(unrealized, 3),
                   **_drawdown(equities), "points": len(equities)},
        "trades": {
            "closed": n, "wins": len(wins), "losses": len(losses),
            "win_rate_pct": round(len(wins) / n * 100, 1) if n else None,
            "avg_win": round(gross_win / len(wins), 3) if wins else None,
            "avg_loss": round(-gross_loss / len(losses), 3) if losses else None,
            "largest_win": round(max(wins), 3) if wins else None,
            "largest_loss": round(min(losses), 3) if losses else None,
            "profit_factor": round(gross_win / gross_loss, 2) if gross_loss else (None if not wins else "Infinity"),
            "expectancy_per_trade": round(realized / n, 3) if n else None,
            "by_venue": by_venue, "by_coin": by_coin, "by_close_reason": by_close,
            "recent": list(reversed(trades[-20:])),
        },
        "activity": {"cycles": len(cyc), "quiet_skipped": skipped, "proposer_failures": failed, "trade_proposals": proposed,
                     "rejected": len(rejected), "rejected_by": rej_by, "approved_orders": len([1 for o in orders if o["approved"]]),
                     "fills": sum(1 for o in orders if o["approved"] and (_j(o["result"], {}) or {}).get("ok") and not (_j(o["result"], {}) or {}).get("resting"))},
        "cost": {"llm_usd_total": round(llm_cost, 4), "llm_usd_per_day": round(llm_cost / days, 4),
                 "pnl_per_llm_usd": round((now_eq - start_eq) / llm_cost, 2) if llm_cost else None,
                 "pnl_per_day": round((now_eq - start_eq) / days, 4),
                 "note": "pnl_per_llm_usd < 1 means the model costs more than it earns"},
        "daily": [{"day": d, **v, "pnl": round(v["close"] - v["open"], 3)} for d, v in sorted(daily.items())],
        "paper_assumptions": {"fee_bps": cfg.paper.fee_bps, "slippage_bps": cfg.paper.slippage_bps} if cfg.mode == "paper" else None,
    }
