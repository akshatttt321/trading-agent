# Dashboard API contract (agent/api.py)

Base URL: `https://<DASHBOARD_HOST>` (Caddy → FastAPI on the VPS). All `/api/*` routes require
`Authorization: Bearer <DASHBOARD_TOKEN>`. CORS is enabled for the dashboard origin. All timestamps are
UNIX seconds (float). All money is USD.

## GET /api/health  (no auth)
`{"ok": true, "mode": "paper|testnet|live", "ts": 1724700000.0}`

## GET /api/status
```json
{
  "mode": "paper",
  "killed": null | "reason string",
  "daily_halt": false,
  "starting_equity": 1000.0,
  "start_ts": 1724700000.0,
  "goal": {"target_multiple": 2.0, "horizon_days": 10},
  "equity": 1012.4,
  "multiple": 1.0124,
  "days_elapsed": 1.4,
  "last_cycle_ts": 1724790000.0,
  "cycles_total": 288,
  "snapshot": {                       // AccountSnapshot from the latest cycle
    "ts": 1724790000.0, "equity_usd": 1012.4, "available_usd": 700.1,
    "perps": [{"coin":"BTC","size":0.0031,"entry_px":78400.0,"mark_px":78900.0,"notional_usd":245.0,
               "unrealized_pnl":1.55,"leverage":3.0,"liquidation_px":55000.0,"stop_px":76800.0,"tp_px":81500.0}],
    "spot":  [{"coin":"HYPE/USDC","amount":1047.5,"value_usd":99.9}],
    "pm":    [{"market_id":"123","token_id":"0xabc","question":"Will X happen by ...?","outcome":"Yes",
               "shares":50.0,"avg_price":0.42,"cur_price":0.47,"value_usd":23.5}]
  }
}
```

## GET /api/equity?limit=1000
`[{"ts": 1724700000.0, "equity": 1000.0}, ...]` oldest → newest, one point per cycle.

## GET /api/cycles?limit=30&kind=...&venue=all|crypto|pm
Two server-side axes, each returning the `limit` most-recent matching cycles.
`venue`: all | crypto (perp/spot orders) | pm (prediction-market orders).
`kind`: all | new (entry fills) | updates (management fills) | trades (either) | rejected | holds | quiet | errors.
new/updates/trades/rejected are filtered to the chosen `venue`; holds/quiet/errors are venue-agnostic (global).
```json
[{"id": 288, "ts": 1724790000.0, "equity": 1012.4, "error": "",
  "decision": {"market_view": "...", "notes": "...",
               "actions": [{"kind":"open_perp","coin":"BTC","side":"long","size_usd":250,"leverage":3,
                            "stop_loss_px":76800,"take_profit_px":81500,"reason":"...","confidence":0.6}]},
  "orders": [{"ts":..., "approved": true, "risk_reason": "approved (clamped: ...) | rr: RR=1.99 ...",
              "action": {...same shape as above...},
              "result": {"ok": true, "detail": "paper fill long 0.0031 BTC @ 78487 (fee $0.09)"}}]
}]
```
newest first. `orders[].approved=false` means the risk gate / RR model rejected it (`risk_reason` says why).
`approved=true && result.ok=false` means the venue failed the order.

## GET /api/orders?limit=200
Flat list of orders (same shape as `cycles[].orders[]` plus `cycle_id`), newest first.

## GET /api/learner
```json
{"lessons": "Closed trades: 12, win rate 42%, realized $-8.20\n  perp|BTC|long|mid|flat: Q=+0.31R ...",
 "contexts": [{"ctx":"perp|BTC|long|mid|flat","q":0.31,"n":5,"wins":2,"total_r":1.2,"total_pnl":14.2}],
 "open": [{"key":"BTC","ctx":"perp|BTC|long|mid|flat","risk_usd":12.5,"ts":...}]}
```

## GET /api/config
Sanitized config (no secrets): `{"mode","loop_interval_seconds","llm":{"model"},"goal":{...},"universe":{...},
"risk":{...},"rr":{...},"learner":{...}}`.

## POST /api/kill
Body: `{"confirm": "KILL"}`. Writes `data/KILL`; the agent flattens every position and stops within 5 s.
Returns `{"ok": true, "message": "..."}`. Idempotent.

## Errors
401 `{"detail":"invalid token"}` · 404 `{"detail":"no data yet"}` (agent hasn't completed a cycle) · 5xx text.

## Frontend requirements
Static site (no build step required), deployable to GitHub Pages. Settings panel (gear) stores
`apiBase` and `token` in localStorage; until set, show a **demo mode** with realistic mock data so the
page is useful before the VPS exists. Poll `/api/status` + `/api/equity` every 30 s. Show clearly:
mode badge (PAPER / TESTNET / **LIVE** in red), equity + multiple vs 2x target with days elapsed/remaining,
equity curve, open positions table (perps/spot/PM with stop/tp/upnl), decision feed (market_view + actions with
FILLED / REJECTED / FAILED tags and reasons), learner table, risk limits panel, and a **KILL SWITCH** button
that requires typing `KILL` to confirm. Dark theme. Mobile-friendly.
