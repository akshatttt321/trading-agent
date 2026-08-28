# trading-agent

Autonomous trading agent for **Hyperliquid perps + spot** and **Polymarket prediction markets**,
with a two-model decision loop (proposer + independent verifier; Gemini free tier by default, OpenAI /
Anthropic pluggable) wrapped in a deterministic risk gate, a risk-reward model, and an online
reinforcement learner.

> **Read this first.** The owner's mandate to this agent is "2x in 7–10 days". That is roughly
> 7–10 % compounding per day. No strategy delivers that reliably; an agent pushed toward it will
> tend toward maximum risk. The hard risk rules in `config.yaml` are the only thing standing between
> that mandate and a zeroed account. Loosen them knowingly. Expect to lose the stake.

## Architecture

```
market_data.py  ─┐
state.py (journal, history, learner memory) ─┤
                                             ▼
                                   llm.py (Claude) ── proposes Decision{actions[]}
                                             │
                        risk.py  ────────────┤  hard caps: leverage, size, exposure, count,
                        (deterministic gate) │  stop required, daily-loss halt, drawdown KILL
                                             │
                        rr_model.py ─────────┤  R:R >= 1.5, EV>0, fractional-Kelly sizing,
                        (risk-reward model)  │  max-risk-per-trade cap (config)
                                             │
                        learner.py ──────────┤  size multiplier per setup-context from
                        (online RL / bandit) │  realized R-multiples of past trades
                                             ▼
                        venues/  paper | hyperliquid | polymarket   → fills → journal → learner
```

* **LLM proposes, a second LLM audits, code decides.** The proposer model emits a structured `Decision`;
  an independent verifier model (skeptic prompt, `agent/llm.py`) must approve every risk-adding action and may
  only shrink size or tighten stops — its vetoes are journaled as REJECTED. If the verifier is unreachable the
  cycle fails closed (no new risk). Then every action passes through `risk.py` → `rr_model.py` → learner sizing.
  Providers (`agent/providers.py`): `gemini` (AI Studio key, free tier), `openai` (platform key — ChatGPT
  subscriptions do not include API access), `anthropic`. Set per role in `config.yaml → llm.proposer / llm.verifier`.
* **Risk gate** (`risk.py`): max leverage, per-position and gross notional caps, max open positions,
  mandatory stop-loss within N %, order cooldown/rate limit, daily-loss halt (new risk blocked for
  the rest of the UTC day), **drawdown kill** (flatten everything, write `data/KILL`, exit and refuse
  to restart). Risk-reducing actions (closes, tightening stops) are always allowed.
* **Risk-reward model** (`rr_model.py`): rejects trades whose take-profit/stop geometry gives
  reward:risk < `rr.min_reward_risk` or negative expected value at the model's stated confidence;
  sizes with fractional Kelly and caps $-at-risk per trade. For prediction markets it demands a
  minimum edge (confidence − market price) and applies Kelly on the implied odds.
* **Online learner** (`learner.py`): every closed trade becomes an R-multiple reward for its context
  `(product | coin | side | confidence bucket | regime)`. Q(ctx) is an EMA of R. Contexts with
  ≥ `min_samples` closes get a size multiplier in `[0.25, 1.0]`; a lessons table (what's working /
  what to avoid) is injected into the LLM's prompt each cycle. This is *online* RL on the agent's
  own trades — it is **not** a pretrained deep-RL policy. Building one needs a historical data set
  and backtest harness (phase 2).
* **Venues**: `paper` (simulated fills on live mainnet prices; stops/TPs simulated each cycle),
  `hyperliquid` (official SDK, API-wallet signing, stop + TP placed as reduce-only trigger orders;
  if the stop cannot be placed the position is closed immediately), `polymarket` (py-clob-client,
  positions from the data API).

## Setup

```bash
cd trading-agent
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # fill GEMINI_API_KEY at minimum (free: aistudio.google.com)
.venv/bin/python -m agent.main --once     # one paper cycle
.venv/bin/python -m agent.main            # loop (every loop_interval_seconds)
```

Ops:

```bash
.venv/bin/python scripts/status.py    # equity, positions, learner table, recent decisions
.venv/bin/python scripts/kill.py      # emergency stop: agent flattens & exits within 5 s
.venv/bin/python scripts/flatten.py   # close everything now (agent running or not)
sqlite3 data/journal.sqlite 'select ts,equity from cycles order by id desc limit 20'
```

## Modes

| mode      | fills           | needs                                                       |
|-----------|-----------------|-------------------------------------------------------------|
| `paper`   | simulated       | an LLM key: `GEMINI_API_KEY` (default, free) / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |
| `testnet` | real, fake USDC | + Hyperliquid **testnet** API wallet + address              |
| `live`    | **real money**  | + mainnet API wallet, Polymarket key, and `LIVE_TRADING_ACK` |

Going live is deliberately three separate steps you do yourself:

1. On Hyperliquid, create an **API wallet** (More → API). It can trade but **cannot withdraw**.
   Put its private key in `HL_API_WALLET_PRIVATE_KEY`, your main address in `HL_ACCOUNT_ADDRESS`.
2. For Polymarket, use a **fresh Polygon wallet** funded only with what you're willing to lose.
3. Set `mode: live` in `config.yaml` **and** `LIVE_TRADING_ACK=I_UNDERSTAND_THIS_IS_REAL_MONEY_AND_I_CAN_LOSE_ALL_OF_IT`
   in `.env`. Without the exact string the agent refuses to start.

Never put a private key in a chat, a ticket, or a commit. `.env` and `data/` are git-ignored.

## Deploy (24/7)

**Preflight first, always**: `.venv/bin/python scripts/preflight.py` proves the target machine can run
the agent (proposer + verifier keys valid, Hyperliquid reachable + universe exists, Polymarket not geo-blocked, account
funded, clock in sync, kill switch clear). Exit code 0 or the agent must not be started there.

**One-command VPS deploy**: `./deploy/remote_deploy.sh root@<ip>` — installs Docker, syncs the repo and
your `.env`, runs preflight *inside the container on the server*, and only starts the agent if every
check passes. Pick a region where Hyperliquid and Polymarket are not blocked (EU works; US does not —
both venues block US IPs).

Step-by-step server creation: `deploy/HETZNER.md`.

**Docker** (anywhere): `docker compose -f deploy/docker-compose.yml up -d --build` — starts three
containers: `agent` (trading loop), `api` (dashboard API, `agent/api.py`), `caddy` (automatic HTTPS for
the API on `DASHBOARD_HOST`).

## Dashboard

`ui/` is a static single-page dashboard (no build step) hosted on GitHub Pages; it talks to the VPS over
HTTPS using `DASHBOARD_TOKEN` (gear icon → API base URL + token, stored in the browser only). Shows mode,
equity vs the 2x target, equity curve, open positions, the decision feed with FILLED / REJECTED / FAILED
reasons, the learner table, risk limits, and a KILL SWITCH (type `KILL` to confirm → `POST /api/kill`).
Contract: `ui/API.md`. Until an API is configured it runs on demo data.

**systemd** (VPS): copy the repo to `/opt/trading-agent`, create the venv, then see the header of
`deploy/trading-agent.service`. A $5–10/month VPS is plenty; the agent makes one LLM call per cycle.

Kill switch works in both: `touch data/KILL` (or `scripts/kill.py`). The agent flattens, exits,
and refuses to restart until you delete `data/KILL` and clear the `killed` flag
(`sqlite3 data/journal.sqlite "delete from meta where key='killed'"`).

## Admin panel (Google sign-in)

The dashboard's **Admin** panel can change every setting in `config.yaml` (mode, models, risk limits, universe, stance…),
store secrets (API keys, wallet keys, live acknowledgement) and run preflight / restart / journal reset — protected by
**Google sign-in**: only the account whose email equals `ADMIN_EMAIL` on the server is accepted (ID token verified
server-side against `GOOGLE_CLIENT_ID`). Setup: Google Cloud Console → APIs & Services → Credentials → *Create OAuth
client ID* (Web application) with the dashboard origin as an authorized JavaScript origin; put the client id in `.env`.
Settings are written to `config.yaml`, secrets to `data/secrets.env` (mode 600, override `.env`); the agent notices
the change and restarts itself within 5 s (positions untouched). Switching to **live** additionally requires the
Hyperliquid keys, the `LIVE_TRADING_ACK` phrase stored as a secret, and typing the phrase again in the request.
Contract: `ui/API_ADMIN.md`.

## Tuning

`llm.stance` switches the model instructions: `active` (paper testing — take rule-compliant setups readily so the
learner gets closed trades) vs `conservative` (real money — HOLD is the default). **Set `conservative` before going live.**

Everything the owner controls is in `config.yaml`: universe, loop interval, goal/mandate, hard risk
limits, risk-reward thresholds, learner parameters. The LLM sees the limits (so it proposes inside
them) but cannot modify them. Raising `max_leverage` / `max_position_pct_equity` / `max_drawdown_pct`
is how you turn this from "survivable" into "gambling"; that's your call to make, not the agent's.

## Day-2 additions

* **Correlation cap** (`risk.max_same_direction_perps`), **stale-position auto-close** (`risk.max_position_age_hours`)
  and **adverse-funding refusal** (`risk.max_adverse_funding_pct_8h`) — enforced in `risk.py`/`main.py`, not left to the model.
* **Post-mortems**: after every close a cheap model writes a 2-line lesson; the last N are shown to the proposer.
* **Verifier score**: vetoed perp trades are shadow-simulated with their own stop/TP (`learner.shadow_vetoes`) so you can
  see whether the verifier blocks winners or losers. Shown in the Learner panel and `/api/learner`.
* **Adaptive attention** (`llm.attention_threshold`, `quiet_min/max_minutes`, `vol_low/high_atr_pct`): the model is
  consulted when an attention score (price move, signal flips, volume surge, uPnL swing) crosses a threshold, or when a
  volatility-scaled maximum quiet interval elapses (60 min calm → 10 min volatile). Positions near a stop/TP always trigger.
* **Analytics** (`/api/analytics`, dashboard *Performance* panel): win rate, profit factor, expectancy, drawdown, PnL by
  venue/coin/close-reason, activity, LLM cost and PnL-per-$-of-LLM, daily PnL.
* Verifier is skipped for adds to an already-held same-direction position; paper fee/slippage are configurable (`paper.*`);
  nightly journal backups on the server (`/etc/cron.daily/trading-agent-backup` → `/opt/trading-agent/backups/`).

## Data sources & cost

All market data is **free and keyless**: Hyperliquid's public Info API (prices, funding, OI, volume, 1h
candles) and Polymarket's Gamma API. Indicators (RSI, ATR, EMA/SMA trend, MACD, Bollinger position, volume
ratio, OI change) and a per-coin `signal` digest are computed locally in `agent/market_data.py`. The only
paid call is the decision itself. Cost controls in `config.yaml → llm`: model (Haiku default), 15-minute
cycles, quiet gate (skip the LLM when flat and nothing moved), compact payload. A 60-second price watch
handles paper stops / drawdown checks between cycles with no LLM. Token usage is tracked in the journal
(`scripts/status.py`, `/api/status`).

## Known limitations / phase 2

* No news or social feed — decisions are from price/funding/OI/momentum and PM prices only.
* Live realized-PnL for the learner is estimated from unrealized PnL at close time (fills API
  reconciliation is a TODO).
* Polymarket orders are GTC limit orders; unfilled orders are not yet tracked/cancelled automatically.
* No backtester. The learner improves online only; a proper RL policy needs historical replay.
* Hyperliquid spot list must be pairs that exist on the exchange (`HYPE/USDC`, `PURR/USDC`, …).
