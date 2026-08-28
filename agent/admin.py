"""
Admin helpers: config schema for the UI, deep-merge + validate + write config.yaml, secrets file,
Google ID-token verification, restart signalling. Used by agent/api.py.
"""
from __future__ import annotations

import copy
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml
from pydantic import ValidationError

from .config import DATA_DIR, LIVE_ACK, ROOT, Config

CONFIG_PATH = ROOT / "config.yaml"
SECRETS_PATH = DATA_DIR / "secrets.env"
RESTART_FILE = DATA_DIR / "RESTART"

SECRET_KEYS = [
    "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "HL_API_WALLET_PRIVATE_KEY", "HL_ACCOUNT_ADDRESS",
    "POLY_PRIVATE_KEY", "POLY_FUNDER", "POLY_SIGNATURE_TYPE",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "LIVE_TRADING_ACK",
]
# these are identifiers, not credentials - safe to echo back to the admin UI
NON_SENSITIVE = {"HL_ACCOUNT_ADDRESS", "POLY_FUNDER", "POLY_SIGNATURE_TYPE", "TELEGRAM_CHAT_ID"}

MODEL_OPTIONS = {
    "gemini": ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-pro-latest", "gemini-3.1-pro-preview"],
    "openai": ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
    "anthropic": ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
}


# ------------------------------------------------------------------------------------------ schema
def config_schema() -> Dict[str, Dict[str, Any]]:
    models = sum(MODEL_OPTIONS.values(), [])
    S: Dict[str, Dict[str, Any]] = {
        "mode": {"type": "enum", "options": ["paper", "testnet", "live"], "label": "Mode", "danger": True,
                 "help": "paper = simulated fills on live prices; testnet = real orders with fake USDC; live = REAL MONEY"},
        "loop_interval_seconds": {"type": "int", "min": 60, "max": 3600, "label": "Cycle interval (s)", "help": "LLM cost scales with 1/interval"},
        "paper_starting_equity_usd": {"type": "float", "min": 10, "max": 1e7, "label": "Paper starting equity ($)", "help": "applies after a journal reset"},
        # llm
        "llm.proposer.provider": {"type": "enum", "options": ["gemini", "openai", "anthropic"], "label": "Proposer provider"},
        "llm.proposer.model": {"type": "enum", "options": models, "label": "Proposer model", "help": "called every cycle"},
        "llm.proposer.thinking": {"type": "enum", "options": ["none", "minimal", "low", "medium", "high"], "label": "Proposer thinking", "help": "thought tokens are billed as output; minimal = 0 on 3.6 Flash"},
        "llm.verifier.thinking": {"type": "enum", "options": ["none", "minimal", "low", "medium", "high"], "label": "Verifier thinking"},
        "llm.verifier.enabled": {"type": "bool", "label": "Verifier enabled", "danger": True, "help": "second model must approve every risk-adding trade"},
        "llm.verifier.provider": {"type": "enum", "options": ["gemini", "openai", "anthropic"], "label": "Verifier provider"},
        "llm.verifier.model": {"type": "enum", "options": models, "label": "Verifier model"},
        "llm.fallbacks": {"type": "list[model]", "label": "Fallback chain", "help": "tried in order on 429/503"},
        "llm.stance": {"type": "enum", "options": ["active", "conservative"], "label": "Stance", "danger": True,
                       "help": "active = take rule-compliant setups readily (testing); conservative = HOLD by default (real money)"},
        "llm.max_tokens": {"type": "int", "min": 512, "max": 16000, "label": "Max output tokens"},
        "llm.temperature": {"type": "float", "min": 0, "max": 1, "label": "Temperature"},
        "llm.skip_if_quiet": {"type": "bool", "label": "Quiet gate", "help": "skip the model when flat and nothing moved"},
        "llm.move_atr_fraction": {"type": "float", "min": 0.05, "max": 5, "label": "Move threshold (fraction of coin's 1h ATR)", "help": "0.5 = half an hourly range inside one cycle scores 1.0"},
        "llm.quiet_move_pct": {"type": "float", "min": 0, "max": 10, "label": "Fallback move threshold (%) when no ATR"},
        "llm.wakeup_expansion": {"type": "float", "min": 1.0, "max": 5, "label": "Wake-up trigger (3h ATR / 14h ATR)", "help": "coin scores +1 attention and is forced into the prompt when its recent volatility expands by this factor"},
        "llm.attention_threshold": {"type": "float", "min": 0.1, "max": 10, "label": "Attention threshold", "help": "score of price move + signal flips + volume + PnL swing needed to consult the model"},
        "llm.hold_streak_step": {"type": "float", "min": 0, "max": 2, "label": "Hold-streak throttle step", "help": "each consecutive HOLD raises the threshold by this fraction"},
        "llm.hold_streak_max_mult": {"type": "float", "min": 1, "max": 10, "label": "Hold-streak max multiplier"},
        "llm.quiet_min_minutes": {"type": "int", "min": 1, "max": 1440, "label": "Forced look interval - volatile (min)"},
        "llm.quiet_max_minutes": {"type": "int", "min": 1, "max": 1440, "label": "Forced look interval - calm (min)"},
        "llm.vol_low_atr_pct": {"type": "float", "min": 0, "max": 10, "label": "Calm BTC ATR% (1h)"},
        "llm.vol_high_atr_pct": {"type": "float", "min": 0, "max": 20, "label": "Volatile BTC ATR% (1h)"},
        "llm.near_level_pct": {"type": "float", "min": 0.1, "max": 20, "label": "Always consult within % of stop/TP"},
        "llm.max_quiet_minutes": {"type": "int", "min": 1, "max": 1440, "label": "Legacy max minutes without a look"},
        "llm.history_cycles": {"type": "int", "min": 0, "max": 30, "label": "History cycles shown to model"},
        "llm.max_calls_per_day": {"type": "int", "min": 1, "max": 100000, "label": "Max LLM calls / day"},
        "llm.max_usd_per_day": {"type": "float", "min": 0, "max": 1000, "label": "Max LLM spend / day ($)"},
        "llm.pm_interval_min": {"type": "int", "min": 1, "max": 1440, "label": "Prediction-market look interval (min)"},
        "llm.pm_move_trigger_pct": {"type": "float", "min": 1, "max": 100, "label": "PM look trigger: held token move %"},
        "llm.prices": {"type": "map[str->list[float]]", "label": "Model prices ($/1M in, $/1M out)"},
        # goal
        "goal.target_multiple": {"type": "float", "min": 1, "max": 100, "label": "Target multiple"},
        "goal.horizon_days": {"type": "int", "min": 1, "max": 3650, "label": "Horizon (days)"},
        "goal.mandate": {"type": "text", "label": "Mandate (verbatim in the model's instructions)"},
        # universe
        "universe.perps": {"type": "list[str]", "label": "Extra perps (outside buckets)", "help": "the universe is the union of the buckets below; add stragglers here"},
        **{f"universe.buckets.{b}.coins": {"type": "list[str]", "label": f"Bucket {b}: coins"} for b in ("majors", "midcaps", "movers")},
        **{f"universe.buckets.{b}.look_every_min": {"type": "int", "min": 1, "max": 1440, "label": f"Bucket {b}: review every (min)"} for b in ("majors", "midcaps", "movers")},
        **{f"universe.buckets.{b}.max_shown": {"type": "int", "min": 1, "max": 30, "label": f"Bucket {b}: max coins shown per cycle"} for b in ("majors", "midcaps", "movers")},
        **{f"universe.buckets.{b}.max_positions": {"type": "int", "min": 0, "max": 20, "label": f"Bucket {b}: max open positions", "danger": True} for b in ("majors", "midcaps", "movers")},
        "universe.spot": {"type": "list[str]", "label": "Spot pairs (e.g. HYPE/USDC)"},
        "universe.prediction_markets.enabled": {"type": "bool", "label": "Prediction markets enabled"},
        "universe.prediction_markets.max_days_to_resolution": {"type": "int", "min": 1, "max": 365, "label": "PM: max days to resolution"},
        "universe.prediction_markets.min_liquidity_usd": {"type": "float", "min": 0, "max": 1e9, "label": "PM: min liquidity ($)"},
        "universe.prediction_markets.max_markets_shown": {"type": "int", "min": 1, "max": 50, "label": "PM: markets shown to model"},
        "universe.prediction_markets.prefer_keywords": {"type": "list[str]", "label": "PM: preferred keywords (ranked first)"},
        "universe.prediction_markets.min_preferred": {"type": "int", "min": 0, "max": 50, "label": "PM: min preferred markets shown"},
        "universe.prediction_markets.max_buy_price": {"type": "float", "min": 0.05, "max": 0.99, "label": "PM: max buy price", "danger": True},
        "universe.prediction_markets.min_hours_to_resolution": {"type": "float", "min": 0, "max": 720, "label": "PM: min hours to resolution", "danger": True},
        "universe.prediction_markets.min_strike_distance_pct": {"type": "float", "min": 0, "max": 50, "label": "PM: min distance from strike (%)", "danger": True},
        "universe.prediction_markets.edge_slope": {"type": "float", "min": 0, "max": 2, "label": "PM: extra edge per unit price above 0.5"},
        "universe.prediction_markets.max_research_edge": {"type": "float", "min": 0.05, "max": 0.9, "label": "PM: max research edge (reject implausible)", "danger": True},
        "universe.prediction_markets.swing_min_hours": {"type": "float", "min": 0, "max": 720, "label": "PM swing: min hours to resolution"},
        "universe.prediction_markets.swing_min_price": {"type": "float", "min": 0.01, "max": 0.9, "label": "PM swing: min token price"},
        "universe.prediction_markets.swing_min_target_gap": {"type": "float", "min": 0, "max": 0.5, "label": "PM swing: min target gap above entry"},
        "paper.pm_slippage_cents": {"type": "float", "min": 0, "max": 10, "label": "Paper PM slippage (cents per side)"},
        "universe.prediction_markets.research_enabled": {"type": "bool", "label": "PM research (grounded web search for non-crypto)"},
        "universe.prediction_markets.research_per_cycle": {"type": "int", "min": 0, "max": 10, "label": "PM research: markets per cycle"},
        "universe.prediction_markets.research_cache_hours": {"type": "float", "min": 0.5, "max": 168, "label": "PM research: cache (hours)"},
        "universe.prediction_markets.research_max_usd_per_day": {"type": "float", "min": 0, "max": 20, "label": "PM research: max $/day"},
        "universe.prediction_markets.research_model": {"type": "str", "label": "PM research model (grounded search)"},
        "notify.min_level": {"type": "enum", "options": ["info", "warning", "error"], "label": "Alert minimum level"},
        "llm.verify_loss_exits": {"type": "bool", "label": "Verifier reviews loss-realising exits", "danger": True},
        # risk (all danger)
        "risk.max_leverage": {"type": "int", "min": 1, "max": 50, "label": "Max leverage", "danger": True},
        "risk.max_position_pct_equity": {"type": "float", "min": 1, "max": 100, "label": "Max position (% equity)", "danger": True},
        "risk.max_gross_exposure_pct": {"type": "float", "min": 1, "max": 1000, "label": "Max gross exposure (%)", "danger": True},
        "risk.max_open_positions": {"type": "int", "min": 1, "max": 50, "label": "Max open positions", "danger": True},
        "risk.max_daily_loss_pct": {"type": "float", "min": 0.5, "max": 100, "label": "Daily loss halt (%)", "danger": True},
        "risk.max_drawdown_pct": {"type": "float", "min": 1, "max": 100, "label": "Drawdown KILL (%)", "danger": True},
        "risk.require_stop_loss": {"type": "bool", "label": "Require stop-loss", "danger": True},
        "risk.max_stop_distance_pct": {"type": "float", "min": 0.1, "max": 50, "label": "Max stop distance (%)", "danger": True},
        "risk.min_seconds_between_orders": {"type": "int", "min": 0, "max": 86400, "label": "Order cooldown (s)"},
        "risk.max_orders_per_hour": {"type": "int", "min": 1, "max": 1000, "label": "Max orders / hour (entries + closes)"},
        "risk.min_stop_atr_mult": {"type": "float", "min": 0, "max": 5, "label": "Trailing guard: min stop distance (x 1h ATR)"},
        "risk.min_stop_pct": {"type": "float", "min": 0, "max": 20, "label": "Trailing guard: min stop distance (%)"},
        "risk.breakeven_after_r": {"type": "float", "min": 0, "max": 10, "label": "Trailing guard: allow breakeven+ after (R)"},
        "risk.tp_extend_min_confidence": {"type": "float", "min": 0.5, "max": 0.99, "label": "Target extension: min stated confidence"},
        "risk.min_order_usd": {"type": "float", "min": 1, "max": 1e6, "label": "Min order ($)"},
        "risk.prediction_market_max_pct_equity": {"type": "float", "min": 0, "max": 100, "label": "PM max per market (% equity)", "danger": True},
        "risk.prediction_market_max_total_pct": {"type": "float", "min": 0, "max": 100, "label": "PM max total (% equity)", "danger": True},
        "risk.min_equity_usd": {"type": "float", "min": 0, "max": 1e7, "label": "Min equity ($) before stop"},
        "risk.same_direction_caps": {"type": "list[str]", "label": "Same-direction perp caps by trend strength 0..4", "danger": True,
                                      "help": "five integers, e.g. 3,3,5,6,7 - strength = breadth>=50% (+1), >=75% (+1), BTC regime agrees (+1), BTC 24h momentum agrees (+1)"},
        "risk.max_same_direction_risk_pct": {"type": "float", "min": 0.5, "max": 100, "label": "Same-direction $-at-risk budget (% equity)", "danger": True, "help": "combined distance-to-stop losses of all same-direction perps"},
        "risk.max_position_age_hours": {"type": "float", "min": 0, "max": 720, "label": "Auto-close positions older than (h)", "help": "0 = off"},
        "risk.max_adverse_funding_pct_8h": {"type": "float", "min": 0, "max": 5, "label": "Max adverse funding %/8h for new positions"},
        "risk.anti_chase_bb": {"type": "float", "min": 0, "max": 1, "label": "Anti-chase: Bollinger position limit (0 = off)"},
        "risk.anti_chase_rsi": {"type": "float", "min": 50, "max": 95, "label": "Anti-chase: RSI limit"},
        "risk.min_entry_stop_atr_mult": {"type": "float", "min": 0, "max": 5, "label": "Min initial stop distance (x 1h ATR)"},
        "risk.loss_streak_throttle": {"type": "float", "min": 0.1, "max": 1, "label": "Throttle after 2 stop-outs (size x)"},
        "risk.loss_streak_hours": {"type": "float", "min": 1, "max": 48, "label": "Throttle duration (h)"},
        "risk.losing_day_mult": {"type": "float", "min": 0.1, "max": 1, "label": "Size x on day after losing day"},
        "risk.reentry_cooldown_min": {"type": "float", "min": 0, "max": 1440, "label": "Re-entry cooldown after stop-out (min)"},
        "risk.scale_out_r": {"type": "float", "min": 0, "max": 10, "label": "Scale-out at (R), 0 = off"},
        "risk.scale_out_frac": {"type": "float", "min": 0.1, "max": 0.9, "label": "Scale-out fraction"},
        "risk.chop_max_entries_per_day": {"type": "int", "min": 0, "max": 100, "label": "Chop regime: max entries/day", "danger": True},
        "risk.beta_weighted_risk": {"type": "bool", "label": "Beta-weight same-direction risk budget"},
        "llm.dead_hour_mult": {"type": "float", "min": 1, "max": 5, "label": "Dead-hours attention multiplier"},
        "paper.fee_bps": {"type": "float", "min": 0, "max": 50, "label": "Paper fee (bps)"},
        "paper.slippage_bps": {"type": "float", "min": 0, "max": 100, "label": "Paper slippage (bps)"},
        "learner.postmortems": {"type": "bool", "label": "Post-mortems after each close"},
        "learner.postmortems_shown": {"type": "int", "min": 0, "max": 50, "label": "Post-mortems shown to model"},
        "learner.shadow_vetoes": {"type": "bool", "label": "Shadow-simulate vetoed trades (verifier score)"},
        "learner.shadow_expiry_hours": {"type": "float", "min": 1, "max": 720, "label": "Shadow trade expiry (h)"},
        # rr / learner
        "rr.min_reward_risk": {"type": "float", "min": 0.5, "max": 10, "label": "Min reward:risk", "danger": True},
        "rr.max_risk_per_trade_pct": {"type": "float", "min": 0.1, "max": 50, "label": "Max risk per trade (% equity)", "danger": True},
        "rr.kelly_fraction": {"type": "float", "min": 0.01, "max": 1, "label": "Kelly fraction"},
        "rr.pm_min_edge": {"type": "float", "min": 0, "max": 0.9, "label": "PM min edge (conf - price)"},
        "learner.enabled": {"type": "bool", "label": "Learner enabled"},
        "learner.alpha": {"type": "float", "min": 0.01, "max": 1, "label": "Learner alpha"},
        "learner.min_samples": {"type": "int", "min": 1, "max": 100, "label": "Learner min samples"},
        "learner.min_multiplier": {"type": "float", "min": 0.05, "max": 1, "label": "Learner min size multiplier"},
        "learner.max_multiplier": {"type": "float", "min": 0.1, "max": 3, "label": "Learner max size multiplier", "danger": True},
        "notify.telegram": {"type": "bool", "label": "Telegram alerts"},
    }
    return S


# ------------------------------------------------------------------------------------------ config io
def read_config_dict() -> Dict[str, Any]:
    return yaml.safe_load(CONFIG_PATH.read_text()) or {}


def deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def validate_config(d: Dict[str, Any]) -> Tuple[Optional[Config], str]:
    try:
        return Config(**d), ""
    except ValidationError as e:
        errs = "; ".join(".".join(str(x) for x in er["loc"]) + ": " + er["msg"] for er in e.errors())
        return None, errs


def write_config(d: Dict[str, Any]) -> None:
    header = ("# Written by the dashboard admin panel. Comments from the original file are not preserved.\n"
              "# Field documentation: ui/API_ADMIN.md and README.md\n")
    # config.yaml is bind-mounted as a single file in Docker: a rename onto it fails (EBUSY), so write in place.
    # The text is small and written in one call; the agent re-parses on mtime change and restarts again if unlucky.
    text = header + yaml.safe_dump(d, sort_keys=False, allow_unicode=True)
    yaml.safe_load(text)  # never write something we cannot read back
    with open(CONFIG_PATH, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())


# ------------------------------------------------------------------------------------------ secrets
def read_secrets() -> Dict[str, str]:
    out: Dict[str, str] = {}
    if SECRETS_PATH.exists():
        for line in SECRETS_PATH.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def write_secrets(updates: Dict[str, str]) -> Dict[str, str]:
    cur = read_secrets()
    for k, v in updates.items():
        if k not in SECRET_KEYS:
            continue
        if v is None or v == "":
            cur.pop(k, None)
        else:
            cur[k] = str(v).strip()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SECRETS_PATH.with_suffix(".env.tmp")
    tmp.write_text("".join(f"{k}={v}\n" for k, v in cur.items()))
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRETS_PATH)
    return cur


def secrets_status() -> Dict[str, Any]:
    """set/not-set map; identifiers echoed, credentials never."""
    env_and_file = {k: os.getenv(k) for k in SECRET_KEYS}
    env_and_file.update({k: v for k, v in read_secrets().items()})
    out: Dict[str, Any] = {}
    for k in SECRET_KEYS:
        v = env_and_file.get(k)
        out[k] = (v or "") if k in NON_SENSITIVE else bool(v)
    return out


def live_prerequisites(cfg_dict: Dict[str, Any], confirm_live: Optional[str]) -> List[str]:
    """Reasons a switch to live must be refused (empty list = allowed)."""
    s = {**{k: os.getenv(k) for k in SECRET_KEYS}, **read_secrets()}
    problems = []
    if s.get("LIVE_TRADING_ACK") != LIVE_ACK:
        problems.append("LIVE_TRADING_ACK secret is not set to the exact acknowledgement phrase")
    if not s.get("HL_API_WALLET_PRIVATE_KEY") or not s.get("HL_ACCOUNT_ADDRESS"):
        problems.append("Hyperliquid API wallet key and account address are required")
    if confirm_live != LIVE_ACK:
        problems.append("request must include confirm_live with the exact phrase")
    return problems


# ------------------------------------------------------------------------------------------ restart
def request_restart(reason: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESTART_FILE.write_text(f"{time.time()} {reason}\n")


# ------------------------------------------------------------------------------------------ google auth
def verify_google_id_token(token: str, client_id: str) -> Tuple[Optional[str], str]:
    """Returns (verified email, error)."""
    try:
        from google.auth.transport import requests as greq
        from google.oauth2 import id_token as gid
        info = gid.verify_oauth2_token(token, greq.Request(), client_id)
        if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            return None, "bad issuer"
        if not info.get("email_verified"):
            return None, "email not verified"
        return str(info.get("email", "")).lower(), ""
    except Exception as e:
        return None, f"invalid google token: {e}"


def mask_email(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    u, d = email.split("@", 1)
    return (u[0] + "…" + u[-1] if len(u) > 2 else u[0] + "…") + "@" + d
