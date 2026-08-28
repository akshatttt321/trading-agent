# Admin API contract (extends ui/API.md)

Two auth levels:

| level | header | who | can |
|---|---|---|---|
| viewer | `Authorization: Bearer <DASHBOARD_TOKEN>` | anyone with the token | all GET `/api/*`, `POST /api/kill` |
| **admin** | `Authorization: Bearer <Google ID token>` + `X-Admin: google` | only the Google account whose email == `ADMIN_EMAIL` on the server | everything, including `/api/admin/*` |

`GET /api/health` (no auth) now also returns `"google_client_id": "<id>.apps.googleusercontent.com"` (or null if admin
login is not configured) and `"admin_email_hint": "s…5@gmail.com"` (masked). The UI uses `google_client_id` to
initialise **Google Identity Services** (`https://accounts.google.com/gsi/client`, `google.accounts.id.initialize({client_id, callback})`,
render a "Sign in with Google" button). The callback's `credential` is the ID token (JWT, ~1 h lifetime). Store it in
memory/sessionStorage; on any `401` from an admin endpoint, prompt sign-in again. Decode the JWT payload client-side
(base64) only to show the signed-in email; the server does the real verification.

Admin endpoints reject with `401 {"detail": "google sign-in required"}` (no/invalid token), `403 {"detail": "…is not the admin"}`
(valid Google user but wrong email), `503 {"detail": "admin login not configured"}` (server lacks GOOGLE_CLIENT_ID/ADMIN_EMAIL).

## GET /api/admin/settings   (admin)
Returns the live `config.yaml` as JSON, plus a `schema` describing every field so the UI can render forms generically:
```json
{
  "config": { "mode": "paper", "loop_interval_seconds": 180, "paper_starting_equity_usd": 40,
              "llm": {...}, "goal": {...}, "universe": {...}, "risk": {...}, "rr": {...}, "learner": {...}, "notify": {...} },
  "schema": {
    "mode": {"type": "enum", "options": ["paper","testnet","live"], "label": "Mode", "help": "live = REAL MONEY", "danger": true},
    "loop_interval_seconds": {"type": "int", "min": 60, "max": 3600, "label": "Cycle interval (s)"},
    "llm.proposer.model": {"type": "enum", "options": ["gemini-3.6-flash", "..."], "label": "Proposer model"},
    "llm.stance": {"type": "enum", "options": ["active","conservative"], ...},
    "risk.max_leverage": {"type": "int", "min": 1, "max": 20, "label": "Max leverage", "danger": true},
    "universe.perps": {"type": "list[str]", "label": "Perp universe"},
    "goal.mandate": {"type": "text", "label": "Mandate (shown to the model)"},
    ...
  },
  "secrets": { "GEMINI_API_KEY": true, "OPENAI_API_KEY": false, "ANTHROPIC_API_KEY": false,
               "HL_API_WALLET_PRIVATE_KEY": false, "HL_ACCOUNT_ADDRESS": false,
               "POLY_PRIVATE_KEY": false, "POLY_FUNDER": false, "POLY_SIGNATURE_TYPE": "0",
               "TELEGRAM_BOT_TOKEN": false, "TELEGRAM_CHAT_ID": false, "LIVE_TRADING_ACK": false },
  "live_ack_phrase": "I_UNDERSTAND_THIS_IS_REAL_MONEY_AND_I_CAN_LOSE_ALL_OF_IT",
  "agent": {"restart_pending": false, "last_reload_ts": 1724800000.0}
}
```
`schema` keys are dotted paths into `config`. Types: `int`, `float`, `bool`, `str`, `text`, `enum`, `list[str]`, `list[model]`
(list of `{provider, model, enabled}`), `map[str->list[float]]` (prices). Fields with `"danger": true` change risk
exposure — render them with a warning colour and require a confirm click. `secrets` values are `true/false` (set or not),
never the secret itself — except non-sensitive ones (`POLY_SIGNATURE_TYPE`, `HL_ACCOUNT_ADDRESS`, `POLY_FUNDER`, `TELEGRAM_CHAT_ID`)
which are returned as strings.

## PUT /api/admin/settings   (admin)
Body: `{"config": {...full or partial config object...}}`. Server deep-merges into the current config, validates with the
same pydantic model the agent uses, writes `config.yaml`, and signals the agent to restart (it reloads within ~5 s;
positions are untouched — stops live on the exchange / in the journal). Response:
`{"ok": true, "restart": true, "config": {...validated config...}}`; on validation error `422 {"detail": "<field>: <problem>"}`.
Switching `mode` to `live` is refused with `409` unless **all** of: `LIVE_TRADING_ACK` secret is set to the exact phrase,
`HL_API_WALLET_PRIVATE_KEY` + `HL_ACCOUNT_ADDRESS` are set, and the request body also contains `"confirm_live": "<the phrase>"`.

## PUT /api/admin/secrets   (admin)
Body: `{"GEMINI_API_KEY": "AIza…", "LIVE_TRADING_ACK": "I_UNDERSTAND_…", "HL_API_WALLET_PRIVATE_KEY": "0x…", ...}` — any
subset. Empty string deletes a secret. Stored server-side in `data/secrets.env` (mode 600), never returned. Response:
`{"ok": true, "secrets": {...same set/not-set map as above...}, "restart": true}`. UI must show a prominent warning next to
wallet keys: *use a Hyperliquid API wallet (cannot withdraw) and a fresh Polygon burner wallet*.

## POST /api/admin/preflight   (admin)
Runs the server-side preflight with the *current* saved config/secrets (takes 5–30 s). Response:
`{"ok": false, "checks": [{"name": "LLM proposer key + model", "pass": true, "detail": "…"}, ...]}`.
UI: a "Run preflight" button; show results as a checklist. Recommend running it before switching to live.

## POST /api/admin/restart   (admin)
Forces the agent process to restart (reload config). `{"ok": true}`.

## POST /api/admin/reset-journal   (admin, danger)
Body `{"confirm": "RESET"}`. Only allowed when `mode == paper`. Deletes the journal (equity history, learner memory, paper
positions) so a paper test can start fresh with `paper_starting_equity_usd`. `{"ok": true}`.

## UI requirements for the admin panel
- New top-bar button **Admin** → opens a full-page panel (or route `#admin`) with a **Sign in with Google** button when not
  signed in; after sign-in show the email and a sign-out link. Viewer features keep working without Google sign-in.
- Tabs/sections generated from `schema`: **Mode & Goal** (mode switch with the live confirmation flow: preflight results +
  type the phrase), **Models** (proposer/verifier/fallbacks/stance/interval/cost cap/prices), **Risk limits** (danger fields),
  **Risk-reward & Learner**, **Universe** (perps list, spot list, prediction-market filters), **Secrets** (set/not-set with
  inputs to update; never display values), **Maintenance** (preflight, restart, reset journal).
- Every save: PUT partial config → show the validated result and "agent restarting…" until `/api/status.last_cycle_ts` advances.
- The **LIVE** switch is a deliberate multi-step flow: (1) secrets present, (2) preflight passes, (3) type the phrase, (4) confirm.
  Show what will change in red.
- Keep the existing look (dark terminal theme) and keep the dashboard usable on a phone.
