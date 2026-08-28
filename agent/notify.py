from __future__ import annotations

import logging

import httpx
from rich.console import Console
from rich.logging import RichHandler

from .config import Config

console = Console()

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    datefmt="%H:%M:%S",
    handlers=[RichHandler(console=console, rich_tracebacks=True, show_path=False, markup=True)],
)
log = logging.getLogger("agent")


class Notifier:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.tg = bool(cfg.notify.telegram and cfg.telegram_bot_token and cfg.telegram_chat_id)
        self.min_level = {"info": 0, "warning": 1, "error": 2}.get(cfg.notify.min_level, 0)
        if self.tg:
            log.info("telegram alerts enabled")

    def send(self, text: str, level: str = "info") -> None:
        getattr(log, level if level in ("info", "warning", "error") else "info")(text)
        if self.tg and {"info": 0, "warning": 1, "error": 2}.get(level, 0) >= self.min_level:
            try:
                httpx.post(
                    f"https://api.telegram.org/bot{self.cfg.telegram_bot_token}/sendMessage",
                    json={"chat_id": self.cfg.telegram_chat_id, "text": text[:4000]},
                    timeout=10,
                )
            except Exception as e:  # never let alerting crash trading
                log.warning(f"telegram send failed: {e}")
