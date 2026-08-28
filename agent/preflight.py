"""Programmatic preflight checks (used by scripts/preflight.py and the admin API)."""
from __future__ import annotations

import time
from typing import Any, Callable, Dict, List

import httpx

from .config import LIVE_ACK, Config


def run_checks(cfg: Config) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []

    def check(name: str, fn: Callable[[], Any]) -> None:
        t = time.time()
        try:
            detail = fn() or "ok"
            results.append({"name": name, "pass": True, "detail": str(detail), "seconds": round(time.time() - t, 1)})
        except Exception as e:
            results.append({"name": name, "pass": False, "detail": str(e)[:300], "seconds": round(time.time() - t, 1)})

    def disk_and_data():
        from .config import DATA_DIR, KILL_FILE
        DATA_DIR.mkdir(exist_ok=True)
        (DATA_DIR / ".w").write_text("x"); (DATA_DIR / ".w").unlink()
        if KILL_FILE.exists():
            raise RuntimeError(f"KILL file present at {KILL_FILE} - remove it before starting")
        return "data/ writable, no KILL file"

    def clock():
        r = httpx.post("https://api.hyperliquid.xyz/info", json={"type": "meta"}, timeout=10)
        server = r.headers.get("date")
        if server:
            from email.utils import parsedate_to_datetime
            drift = abs(time.time() - parsedate_to_datetime(server).timestamp())
            if drift > 30:
                raise RuntimeError(f"clock drift {drift:.0f}s (signatures will fail) - fix NTP")
            return f"drift {drift:.0f}s"
        return "no server date header"

    def _llm(ref):
        from .providers import make_provider
        return make_provider(ref.provider, ref.model, cfg.key_for(ref.provider), 512, 0.0, ref.thinking).ping()

    def llm_proposer():
        return _llm(cfg.llm.proposer)

    def llm_verifier():
        if not cfg.llm.verifier.enabled:
            return "verifier disabled - skipped (single-model mode)"
        return _llm(cfg.llm.verifier)

    def hyperliquid_data():
        from .market_data import MarketData
        md = MarketData(cfg)
        perps = md.perp_overview()
        missing = [c for c in cfg.universe.perps if c not in perps]
        if missing:
            raise RuntimeError(f"perps not found on exchange: {missing}")
        spot = md.spot_overview()
        missing = [p for p in cfg.universe.spot if p not in spot]
        if missing:
            raise RuntimeError(f"spot pairs not found: {missing}")
        return f"{len(perps)} perps, {len(spot)} spot pairs, BTC={perps['BTC']['mark'] if 'BTC' in perps else '?'}"

    def polymarket_reachable():
        if not cfg.universe.prediction_markets.enabled:
            return "disabled in config - skipped"
        httpx.get("https://gamma-api.polymarket.com/markets", params={"limit": 1}, timeout=15).raise_for_status()
        httpx.get("https://clob.polymarket.com/time", timeout=15).raise_for_status()
        return "gamma + clob reachable (not geo-blocked here)"

    def hl_account():
        if cfg.mode == "paper":
            return "paper mode - skipped"
        from .market_data import MarketData
        from .venues.hyperliquid_venue import HyperliquidVenue
        v = HyperliquidVenue(cfg, MarketData(cfg))
        snap = v.snapshot({})
        if snap.equity_usd <= 0:
            raise RuntimeError(f"account {cfg.hl_account_address} has zero equity on {cfg.mode}")
        return f"equity ${snap.equity_usd:,.2f}, {len(snap.perps)} open perps"

    def poly_account():
        if cfg.mode != "live" or not cfg.poly_private_key or not cfg.universe.prediction_markets.enabled:
            return "not live / no key / disabled - skipped"
        from .venues.polymarket_venue import PolymarketVenue
        snap = PolymarketVenue(cfg).snapshot({})
        return f"USDC ${snap.available_usd:,.2f}, {len(snap.pm)} positions"

    def live_ack():
        if cfg.mode != "live":
            return f"mode={cfg.mode} - not required"
        if cfg.live_ack != LIVE_ACK:
            raise RuntimeError("LIVE_TRADING_ACK missing/incorrect - agent will refuse to start")
        return "present"

    check("data dir + kill switch", disk_and_data)
    check("system clock", clock)
    check("LLM proposer key + model", llm_proposer)
    check("LLM verifier key + model", llm_verifier)
    check("Hyperliquid market data + universe", hyperliquid_data)
    check("Polymarket reachability", polymarket_reachable)
    check("Hyperliquid account", hl_account)
    check("Polymarket account", poly_account)
    check("live acknowledgement", live_ack)
    return results
