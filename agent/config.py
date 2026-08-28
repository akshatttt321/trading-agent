from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
KILL_FILE = DATA_DIR / "KILL"

LIVE_ACK = "I_UNDERSTAND_THIS_IS_REAL_MONEY_AND_I_CAN_LOSE_ALL_OF_IT"


class ModelRef(BaseModel):
    provider: str = "gemini"          # anthropic | gemini | openai
    model: str = "gemini-3.5-flash"
    enabled: bool = True
    thinking: str = "minimal"         # none | minimal | low | medium | high (Gemini thinking budget; thoughts cost output tokens)


class LLMCfg(BaseModel):
    proposer: ModelRef = Field(default_factory=lambda: ModelRef(provider="gemini", model="gemini-3.5-flash-lite"))
    verifier: ModelRef = Field(default_factory=lambda: ModelRef(provider="gemini", model="gemini-3.6-flash", enabled=True))
    fallbacks: List[ModelRef] = Field(default_factory=lambda: [ModelRef(provider="gemini", model="gemini-3.5-flash-lite")])
    max_calls_per_day: int = 800
    prices: Dict[str, List[float]] = Field(default_factory=dict)   # model -> [usd per 1M in, usd per 1M out]
    max_usd_per_day: float = 1.20
    stance: str = "conservative"   # active | conservative
    max_tokens: int = 1500
    temperature: float = 0.2
    skip_if_quiet: bool = True
    quiet_move_pct: float = 1.0
    move_atr_fraction: float = 0.5
    wakeup_expansion: float = 1.5
    max_quiet_minutes: int = 60
    near_level_pct: float = 1.0   # consult the model when a position is this close (%) to its stop/TP
    attention_threshold: float = 1.3
    hold_streak_step: float = 0.25
    hold_streak_max_mult: float = 3.0
    quiet_min_minutes: int = 10
    quiet_max_minutes: int = 60
    dead_hours: List[int] = Field(default_factory=lambda: [2, 6])   # [start,end) UTC: attention threshold x dead_hour_mult
    dead_hour_mult: float = 1.5
    # --- position-manager brain (2nd agent): cheap model that reviews OPEN positions on its own fast cadence ---
    manager_enabled: bool = True
    manager: ModelRef = Field(default_factory=lambda: ModelRef(provider="gemini", model="gemini-3.5-flash-lite", thinking="minimal"))
    manager_interval_min: int = 10           # max minutes between manager looks while positions are open
    manager_min_move_atr15: float = 0.5      # wake early: held coin moved this x its 15m ATR since last look
    manager_min_upnl_swing_pct: float = 0.4  # wake early: total uPnL swung this % of equity
    vol_low_atr_pct: float = 0.3
    vol_high_atr_pct: float = 1.5
    history_cycles: int = 5
    pm_interval_min: int = 30
    pm_move_trigger_pct: float = 10
    verify_loss_exits: bool = True


class GoalCfg(BaseModel):
    target_multiple: float = 2.0
    horizon_days: int = 10
    mandate: str = ""


class PMCfg(BaseModel):
    enabled: bool = True
    max_days_to_resolution: int = 60
    min_liquidity_usd: float = 25000
    max_markets_shown: int = 15
    prefer_keywords: List[str] = Field(default_factory=list)
    min_preferred: int = 0
    max_buy_price: float = 0.75
    min_hours_to_resolution: float = 12
    min_strike_distance_pct: float = 2.0
    edge_slope: float = 0.2
    swing_min_hours: float = 24
    swing_min_price: float = 0.08
    swing_min_target_gap: float = 0.04
    max_research_edge: float = 0.35
    research_enabled: bool = True
    research_model: str = "gemini-3.5-flash-lite"
    research_per_cycle: int = 2
    research_cache_hours: float = 12
    research_max_usd_per_day: float = 0.30


class BucketCfg(BaseModel):
    coins: List[str] = Field(default_factory=list)
    look_every_min: int = 15        # minimum minutes between showings of a coin (unless held / top mover)
    max_shown: int = 4              # at most this many coins of the bucket in one prompt
    max_positions: int = 3          # open perps allowed in this bucket


class UniverseCfg(BaseModel):
    perps: List[str] = Field(default_factory=list)
    buckets: Dict[str, BucketCfg] = Field(default_factory=dict)
    spot: List[str] = Field(default_factory=list)
    prediction_markets: PMCfg = Field(default_factory=PMCfg)

    def model_post_init(self, __context) -> None:
        if self.buckets:
            seen: List[str] = []
            for b in self.buckets.values():
                for c in b.coins:
                    if c not in seen:
                        seen.append(c)
            # buckets define the universe; any extra coins listed in perps are appended
            self.perps = seen + [c for c in self.perps if c not in seen]
        if not self.perps:
            self.perps = ["BTC", "ETH", "SOL"]

    def bucket_of(self, coin: str) -> Optional[str]:
        for name, b in self.buckets.items():
            if coin in b.coins:
                return name
        return None


class RiskCfg(BaseModel):
    max_leverage: int = 3
    max_position_pct_equity: float = 25
    max_gross_exposure_pct: float = 150
    max_open_positions: int = 8
    max_daily_loss_pct: float = 8
    max_drawdown_pct: float = 25
    require_stop_loss: bool = True
    max_stop_distance_pct: float = 6
    min_seconds_between_orders: int = 60
    max_orders_per_hour: int = 12
    min_stop_atr_mult: float = 0.75
    min_stop_pct: float = 0.5
    breakeven_after_r: float = 2.0
    tp_extend_min_confidence: float = 0.75
    min_order_usd: float = 10
    prediction_market_max_pct_equity: float = 10
    prediction_market_max_total_pct: float = 25
    min_equity_usd: float = 20
    same_direction_caps: List[int] = Field(default_factory=lambda: [3, 3, 5, 6, 7])
    max_same_direction_risk_pct: float = 6.0
    max_position_age_hours: float = 24
    max_adverse_funding_pct_8h: float = 0.05
    anti_chase_bb: float = 0.9
    anti_chase_rsi: float = 72
    min_entry_stop_atr_mult: float = 1.0
    loss_streak_throttle: float = 0.5
    loss_streak_hours: float = 6
    losing_day_mult: float = 0.75
    reentry_cooldown_min: float = 120
    scale_out_r: float = 1.5
    scale_out_frac: float = 0.5
    chop_max_entries_per_day: int = 2
    beta_weighted_risk: bool = True


class RRCfg(BaseModel):
    min_reward_risk: float = 1.5
    max_risk_per_trade_pct: float = 2.5
    kelly_fraction: float = 0.25
    pm_min_edge: float = 0.05


class PaperCfg(BaseModel):
    fee_bps: float = 4.5
    slippage_bps: float = 8
    pm_slippage_cents: float = 1.0


class LearnerCfg(BaseModel):
    enabled: bool = True
    postmortems: bool = True
    postmortems_shown: int = 10
    shadow_vetoes: bool = True
    shadow_expiry_hours: float = 48
    alpha: float = 0.25
    min_samples: int = 3
    min_multiplier: float = 0.25
    max_multiplier: float = 1.0


class NotifyCfg(BaseModel):
    telegram: bool = True
    min_level: str = "info"


class Config(BaseModel):
    mode: str = "paper"  # paper | testnet | live
    loop_interval_seconds: int = 300
    paper_starting_equity_usd: float = 1000
    llm: LLMCfg = Field(default_factory=LLMCfg)
    goal: GoalCfg = Field(default_factory=GoalCfg)
    universe: UniverseCfg = Field(default_factory=UniverseCfg)
    risk: RiskCfg = Field(default_factory=RiskCfg)
    rr: RRCfg = Field(default_factory=RRCfg)
    paper: PaperCfg = Field(default_factory=PaperCfg)
    learner: LearnerCfg = Field(default_factory=LearnerCfg)
    notify: NotifyCfg = Field(default_factory=NotifyCfg)

    # --- secrets (from env, never from yaml) ---
    anthropic_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    hl_api_wallet_key: Optional[str] = None
    hl_account_address: Optional[str] = None
    poly_private_key: Optional[str] = None
    poly_signature_type: int = 0
    poly_funder: Optional[str] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    live_ack: Optional[str] = None
    google_client_id: Optional[str] = None
    admin_email: Optional[str] = None

    @property
    def is_live(self) -> bool:
        return self.mode == "live"

    @property
    def is_paper(self) -> bool:
        return self.mode == "paper"

    def key_for(self, provider: str) -> Optional[str]:
        return {"anthropic": self.anthropic_api_key, "gemini": self.gemini_api_key, "openai": self.openai_api_key}.get(provider)

    def validate_runtime(self) -> None:
        if self.mode not in ("paper", "testnet", "live"):
            raise SystemExit(f"config.mode must be paper|testnet|live, got {self.mode!r}")
        refs = [self.llm.proposer] + ([self.llm.verifier] if self.llm.verifier.enabled else [])
        for ref in refs:
            if ref.provider not in ("anthropic", "gemini", "openai"):
                raise SystemExit(f"llm provider must be anthropic|gemini|openai, got {ref.provider!r}")
            if not self.key_for(ref.provider):
                env = {"anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY"}[ref.provider]
                raise SystemExit(f"{env} is not set in .env (needed for llm provider {ref.provider!r})")
        if self.mode in ("testnet", "live"):
            if not self.hl_api_wallet_key or not self.hl_account_address:
                raise SystemExit("HL_API_WALLET_PRIVATE_KEY and HL_ACCOUNT_ADDRESS required for testnet/live")
        if self.mode == "live" and self.live_ack != LIVE_ACK:
            raise SystemExit(
                "REFUSING TO START: mode=live but LIVE_TRADING_ACK is missing/incorrect.\n"
                f"Set LIVE_TRADING_ACK={LIVE_ACK} in .env only when you accept that this "
                "agent will trade real funds autonomously and can lose all of them."
            )


def load_config(path: Optional[Path] = None) -> Config:
    load_dotenv(ROOT / ".env")
    # secrets saved from the admin UI override .env (written by agent/admin.py, mode 600)
    if (DATA_DIR / "secrets.env").exists():
        load_dotenv(DATA_DIR / "secrets.env", override=True)
    path = path or ROOT / "config.yaml"
    raw = yaml.safe_load(path.read_text()) or {}
    cfg = Config(**raw)
    cfg.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY") or None
    cfg.gemini_api_key = os.getenv("GEMINI_API_KEY") or None
    cfg.openai_api_key = os.getenv("OPENAI_API_KEY") or None
    cfg.hl_api_wallet_key = os.getenv("HL_API_WALLET_PRIVATE_KEY") or None
    cfg.hl_account_address = os.getenv("HL_ACCOUNT_ADDRESS") or None
    cfg.poly_private_key = os.getenv("POLY_PRIVATE_KEY") or None
    cfg.poly_signature_type = int(os.getenv("POLY_SIGNATURE_TYPE") or 0)
    cfg.poly_funder = os.getenv("POLY_FUNDER") or None
    cfg.telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN") or None
    cfg.telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID") or None
    cfg.live_ack = os.getenv("LIVE_TRADING_ACK") or None
    cfg.google_client_id = os.getenv("GOOGLE_CLIENT_ID") or None
    cfg.admin_email = (os.getenv("ADMIN_EMAIL") or "").strip().lower() or None
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return cfg
