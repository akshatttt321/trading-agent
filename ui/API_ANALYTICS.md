# Analytics contract (extends ui/API.md) — viewer token is enough

## GET /api/analytics
```json
{
  "as_of": 1724800000.0, "since_ts": 1724700000.0, "days": 1.16,
  "equity": {"start": 40.0, "now": 40.36, "multiple": 1.009, "pnl_total": 0.36, "realized": 0.12, "unrealized": 0.24,
             "max_drawdown_usd": 0.41, "max_drawdown_pct": 1.02, "points": 31},
  "trades": {
    "closed": 4, "wins": 2, "losses": 2, "win_rate_pct": 50.0, "avg_win": 0.31, "avg_loss": -0.22,
    "largest_win": 0.40, "largest_loss": -0.30, "profit_factor": 1.41, "expectancy_per_trade": 0.045,
    "by_venue": {"perps": {"trades": 3, "wins": 2, "pnl": 0.30}, "spot": {...}, "prediction_markets": {...}},
    "by_coin":  {"HYPE": {"trades": 2, "wins": 1, "pnl": 0.1}, ...},
    "by_close_reason": {"stop": {"trades": 1, "pnl": -0.3}, "take_profit": {...}, "agent": {...}, "stale": {...}},
    "recent": [{"ts": ..., "kind": "close_perp", "venue": "perps", "coin": "HYPE", "pnl": -0.30, "closed_by": "STOP hit", "detail": "..."}]
  },
  "activity": {"cycles": 31, "quiet_skipped": 8, "proposer_failures": 2, "trade_proposals": 5, "rejected": 2,
               "rejected_by": {"verifier": 1, "risk_gate": 1, "rr_model": 0, "other": 0}, "approved_orders": 9},
  "cost": {"llm_usd_total": 0.145, "llm_usd_per_day": 0.125, "pnl_per_llm_usd": 2.48, "pnl_per_day": 0.31,
           "note": "pnl_per_llm_usd < 1 means the model costs more than it earns"},
  "daily": [{"day": "2026-08-26", "open": 40.0, "close": 40.36, "low": 39.88, "high": 40.40, "pnl": 0.36}],
  "paper_assumptions": {"fee_bps": 4.5, "slippage_bps": 8} | null
}
```
`profit_factor` may be `null` (no trades) or `Infinity` (no losses yet — JSON `Infinity` is not valid; treat non-number as "∞").
Fields may be `null` when there is no data yet — always render an empty state.

## GET /api/learner  (extended)
Existing fields plus:
```json
"postmortems": [{"ts": ..., "coin": "HYPE", "side": "long", "R": -1.0, "pnl": -0.44, "closed_by": "STOP hit",
                 "lesson": "Expected continuation above SMA50; price reversed within 2h...\nLesson: ..."}],   // newest first
"verifier_score": {"resolved": 6, "open": 2, "vetoed_would_have_won": 2, "vetoed_would_have_lost": 4,
                   "avg_r_of_vetoed": -0.45, "sum_r_saved": 2.7, "verdict": "verifier is EARNING its cost (...)"}
                  // or just {"resolved": 0, "open": N} when nothing resolved yet
"rejection_scores": {"all": {...same shape as verifier_score...}, "verifier": {...}, "risk_gate": {...}, "rr_model": {...}},
                    // every rejected perp proposal is shadow-simulated; `by` says who rejected it
"shadow_trades": [{"ts": ..., "coin": "ETH", "side": "short", "entry_px": 2480, "stop_px": 2530, "tp_px": 2400, "by": "verifier|risk_gate|rr_model",
                   "confidence": 0.6, "reason": "VERIFIER: ...", "status": "open|stopped|target|expired", "r": null|-1.0|1.6}]
```

## UI requirements — new "Performance" panel (dashboard, viewer level)
- Place it as a new full-width panel below Open positions (or a tab next to the Decision feed). Poll every 60 s.
- Row of stat tiles: Realized PnL · Unrealized · Win rate (wins/losses) · Profit factor · Expectancy/trade · Max drawdown ($ and %)
  · LLM cost/day · **PnL per $ of LLM** (green ≥ 1, red < 1, with the note as tooltip).
- Small breakdown tables: by venue, by coin, by close reason (stop / take-profit / agent / stale) — trades, win %, PnL.
- Activity strip: cycles · quiet-skipped · proposals · rejected (by verifier / gate / RR) · proposer failures.
- Daily PnL mini bar chart (from `daily`), green/red bars, tooltip with open→close.
- Recent closed trades list (from `trades.recent`), newest first, with closed_by tag.
- In the **Learner** panel: add a "Post-mortems" list (lesson text, R, coin, when) and a **Verifier score** card
  (would-have-won vs would-have-lost, avg R, verdict sentence coloured green/amber), plus a compact shadow-trades table
  (status pills open/stopped/target/expired).
- Empty states everywhere ("No closed trades yet — stats appear after the first stop/TP/close").
- Mock: extend mock.js with realistic analytics/postmortems/verifier_score/shadow_trades so demo mode shows the panel.
