# V2 — build ideas & roadmap

Everything V1 does today is in [README.md](../README.md). This is the backlog for the next
build round, roughly ordered by expected impact per unit of effort. Items marked **pre-live**
are hard requirements before switching `mode: live`.

## 1. Smarter market context

- **Multi-timeframe candles per venue role.** Today every coin gets one feed: 8 days of 1h
  candles (needed as warm-up for ATR14/RSI/SMA50/Bollinger). V2: layer a fast timeframe on top —
  5m/15m candles over the last 12–24h for the *movers* bucket and for any coin with an open
  position, while keeping the 1h/8d feed for regime and indicator warm-up. Entry timing comes
  from the fast frame, trend/bias from the slow frame ("trade the 15m in the direction of the 1h").
- **Order-book / liquidity features.** Spread, top-of-book depth, and recent liquidation clusters
  from Hyperliquid — cheap deterministic inputs that catch thin markets before the model does.
- **Cross-asset regime input.** BTC dominance, funding-rate percentile across the universe, and a
  simple risk-on/risk-off flag instead of feeding every coin in isolation.
- **Event calendar.** CPI/FOMC/major unlock dates injected as "caution windows" (risk gate widens
  stops or blocks new entries 30 min around them).

## 2. Learning & calibration

- **Confidence calibration.** Track predicted confidence vs realized outcome; cap effective
  probability at ~0.65 until the model has earned better (prevents Kelly oversizing on
  overconfident calls).
- **Learner back-off hierarchy.** When a (setup, regime) bucket has few samples, fall back to the
  setup-only bucket, then the global prior, instead of acting on 2-trade noise.
- **Shadow trades with costs.** Shadow fills currently ignore fees/slippage; add the same 4.5 bps
  fee + 8 bps slip the paper venue charges so rejection scoring is honest.
- **Shadow-simulate rejected PM buys** (currently only perp rejections are shadowed).
- **Weekly self-review.** A scheduled job that feeds the week's journal to the model and produces
  a written retro: what worked, what to disable, proposed config diffs (applied only after human OK).
- **Baseline comparison.** Plot agent equity vs buy-and-hold BTC vs random-entry baseline on the
  dashboard, so "is the agent adding anything?" is answerable at a glance.
- **Model A/B.** Run two proposer configs on alternating cycles, journal which one's fills perform
  better, promote the winner.

## 3. Strategy modules

- **Funding-harvest mode.** When funding is extreme, take the carry side with tight stops —
  a second, uncorrelated PnL stream.
- **Watch levels / price alerts.** Let the model set "wake me if BTC crosses X" levels instead of
  polling; pairs with the attention gate to cut cost further.
- **PM theta-aware stops.** Tighten prediction-market stops as resolution approaches (time decay
  makes recovery less likely near expiry).
- **Pair/hedge trades.** Long/short two correlated coins on divergence — market-neutral option for
  chop regimes where directional trading bleeds.

## 4. Pre-live hardening (required before `mode: live`)

- ~~Polymarket live venue: stop/target monitoring, `pm_update`, settlement handling, fill confirmation~~ **BUILT 2026-08-30**
  (agent-held levels executed by venue housekeeping; resolution detected and journaled, redemption manual; buys poll-confirm or cancel).
- ~~Hyperliquid live: close-event reconciliation via the fills API~~ **BUILT 2026-08-30** (trigger oids tracked; user_fills cursor
  turns on-exchange stop/TP executions into journal+learner events; own closes deduped).
- ~~Live resting limit orders~~ **BUILT 2026-08-30** (Alo maker orders on-venue, tick monitors oid, triggers attach on fill,
  TTL/replace cancel on-venue). NOTE: all three built code-complete but UNTESTED against a real venue - the testnet dry run is the gate.
- Config re-tightening for live: `stance: conservative`, `skip_if_quiet: true`, min RR 1.5,
  Kelly 0.25, risk/trade 2.5 %.
- Full dry run on Hyperliquid testnet.
- Secret rotation + alerting on failed auth.

## 5. Platform

- **Threading.** Move the 60 s watcher into its own thread and raise LLM timeout to ~45 s
  (removes the 25 s deadline pressure that forces fallback hops).
- **Postgres option.** SQLite is fine for one box; a managed Postgres makes multi-box or
  restore-from-anywhere trivial.
- **Multi-account.** One agent process, N sub-accounts with independent risk envelopes.
- **Mobile push** (ntfy.sh or similar) in addition to email alerts.

## Non-goals for V2

- HFT/latency-sensitive strategies — this architecture (LLM in the loop, 5 min cycles) is not that.
- Options — Hyperliquid doesn't offer them; revisit if venue support appears.
- Auto-raising risk limits — limits stay human-owned.
