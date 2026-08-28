"""Read-only market data: Hyperliquid perps/spot via Info API, Polymarket via Gamma API."""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

import httpx
from hyperliquid.info import Info
from hyperliquid.utils import constants

from .config import Config
from .notify import log

GAMMA = "https://gamma-api.polymarket.com"


def _f(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _rsi(closes: List[float], n: int = 14) -> Optional[float]:
    if len(closes) < n + 1:
        return None
    gains = losses = 0.0
    for i in range(-n, 0):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return round(100 - 100 / (1 + rs), 1)


def _pct(a: float, b: float) -> Optional[float]:
    return round((a - b) / b * 100, 2) if b else None


def _ema(xs: List[float], n: int) -> List[float]:
    if not xs:
        return []
    k = 2 / (n + 1)
    out = [xs[0]]
    for x in xs[1:]:
        out.append(x * k + out[-1] * (1 - k))
    return out


def _signal_key(c: Dict) -> str:
    """Categorical fingerprint of a coin's state - changes only on real regime/band flips, never on a number wiggle."""
    rsi = c.get("rsi14_1h")
    rsi_b = "na" if rsi is None else "os" if rsi < 30 else "ob" if rsi > 70 else "mid"
    trend = "up" if (c.get("ema20_above_ema50") is True and c.get("above_sma50_1h")) else \
            "down" if (c.get("ema20_above_ema50") is False and not c.get("above_sma50_1h")) else "mixed"
    m = c.get("macd_hist_1h"); macd = "na" if m is None else ("pos" if m > 0 else "neg")
    bb = c.get("bb_pos_1h"); band = "na" if bb is None else "upper" if bb > 0.95 else "lower" if bb < 0.05 else "in"
    f = c.get("funding_8h_pct") or 0; fund = "hi" if f > 0.05 else "neg" if f < -0.02 else "ok"
    v = c.get("vol_ratio_24h") or 0; vol = "surge" if v > 1.5 else "norm"
    return f"{rsi_b}|{trend}|{macd}|{band}|{fund}|{vol}"


def _signal_summary(c: Dict) -> str:
    """Rule-based one-liner so the LLM reads a digest instead of re-deriving it (free, deterministic)."""
    tags = []
    rsi = c.get("rsi14_1h")
    if rsi is not None:
        tags.append("RSI oversold" if rsi < 30 else "RSI overbought" if rsi > 70 else f"RSI {rsi:.0f}")
    if c.get("ema20_above_ema50") is True and c.get("above_sma50_1h"):
        tags.append("uptrend (EMA20>EMA50, px>SMA50)")
    elif c.get("ema20_above_ema50") is False and not c.get("above_sma50_1h"):
        tags.append("downtrend (EMA20<EMA50, px<SMA50)")
    else:
        tags.append("mixed trend")
    m = c.get("macd_hist_1h")
    if m is not None:
        tags.append("MACD rising" if m > 0 else "MACD falling")
    bb = c.get("bb_pos_1h")
    if bb is not None:
        tags.append("at upper band" if bb > 0.95 else "at lower band" if bb < 0.05 else None)
    f = c.get("funding_8h_pct")
    if f is not None:
        if f > 0.05:
            tags.append(f"funding high {f:.3f}% (longs crowded)")
        elif f < -0.02:
            tags.append(f"funding negative {f:.3f}% (shorts crowded)")
    v = c.get("vol_ratio_24h")
    if v is not None and v > 1.5:
        tags.append(f"volume {v:.1f}x avg")
    oi = c.get("oi_chg_pct_since_last")
    if oi is not None and abs(oi) > 3:
        tags.append(f"OI {oi:+.1f}% since last look")
    return "; ".join(t for t in tags if t)


class MarketData:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        url = constants.TESTNET_API_URL if cfg.mode == "testnet" else constants.MAINNET_API_URL
        self.info = Info(url, skip_ws=True)
        self._spot_pair_index: Dict[str, int] = {}
        self._spot_internal_name: Dict[str, str] = {}   # "HYPE/USDC" -> "@107"
        self.sz_decimals: Dict[str, int] = {}
        self.last_pm_prices: Dict[str, float] = {}
        self.pm_questions: Dict[str, str] = {}

    # ------------------------------------------------------------------ perps
    def perp_overview(self) -> Dict[str, Dict]:
        meta, ctxs = self.info.meta_and_asset_ctxs()
        out: Dict[str, Dict] = {}
        for u, c in zip(meta["universe"], ctxs):
            name = u["name"]
            self.sz_decimals[name] = int(u.get("szDecimals", 3))
            if name not in self.cfg.universe.perps:
                continue
            mark = _f(c.get("markPx"))
            out[name] = {
                "mark": mark,
                "mid": _f(c.get("midPx"), mark),
                "chg_24h_pct": _pct(mark, _f(c.get("prevDayPx"))),
                "funding_8h_pct": round(_f(c.get("funding")) * 100, 4),
                "oi_musd": round(_f(c.get("openInterest")) * mark / 1e6, 1),
                "vol_24h_musd": round(_f(c.get("dayNtlVlm")) / 1e6, 1),
            }
        return out

    def candle_stats(self, coin: str) -> Dict:
        end = int(time.time() * 1000)
        start = end - 8 * 24 * 3600 * 1000
        try:
            candles = self.info.candles_snapshot(coin, "1h", start, end)
        except Exception as e:
            log.warning(f"candles {coin}: {e}")
            return {}
        if not candles:
            return {}
        closes = [_f(k["c"]) for k in candles]
        highs = [_f(k["h"]) for k in candles]
        lows = [_f(k["l"]) for k in candles]
        last = closes[-1]
        # indicator STATES (trend / MACD sign / RSI band / Bollinger band) use CLOSED candles only, so they change at
        # most once per hour per coin; the live partial candle would otherwise flicker every cycle across the universe.
        partial = len(candles) > 1 and _f(candles[-1].get("T"), 0) > time.time() * 1000
        cc = closes[:-1] if partial else closes

        def ago(h: int) -> Optional[float]:
            return _pct(last, closes[-h - 1]) if len(closes) > h else None

        trs = [max(h - l, abs(h - closes[i - 1]), abs(l - closes[i - 1])) for i, (h, l) in enumerate(zip(highs, lows)) if i > 0]
        atr = sum(trs[-14:]) / min(14, len(trs)) if trs else 0
        atr3 = sum(trs[-3:]) / min(3, len(trs)) if trs else 0
        expansion = round(atr3 / atr, 2) if atr else None      # >1.5 = last 3h are 50% wilder than the last 14h
        ref = cc[-1] if cc else last                     # last CLOSED price for state comparisons
        sma20 = sum(cc[-20:]) / min(20, len(cc))
        sma50 = sum(cc[-50:]) / min(50, len(cc))
        ema12, ema26 = _ema(cc, 12), _ema(cc, 26)
        macd = [a - b for a, b in zip(ema12, ema26)]
        signal = _ema(macd, 9)
        macd_hist = macd[-1] - signal[-1] if macd and signal else None
        ema20, ema50 = _ema(cc, 20)[-1], _ema(cc, 50)[-1]
        win = cc[-20:]
        mean = sum(win) / len(win)
        sd = (sum((x - mean) ** 2 for x in win) / len(win)) ** 0.5
        bb_pos = (ref - (mean - 2 * sd)) / (4 * sd) if sd else 0.5
        vols = [_f(k["v"]) for k in candles]
        vol_ratio = (sum(vols[-24:]) / 24) / (sum(vols[:-24]) / max(len(vols) - 24, 1)) if len(vols) > 48 else None
        return {
            "_returns": [round((closes[i] / closes[i-1] - 1), 5) for i in range(max(1, len(closes) - 72), len(closes))],
            "chg_1h_pct": ago(1),
            "chg_4h_pct": ago(4),
            "chg_24h_pct": ago(24),
            "chg_7d_pct": ago(168),
            "rsi14_1h": _rsi(cc),
            "atr14_1h_pct": round(atr / last * 100, 2) if last else None,
            "vol_expansion": expansion,
            "high_24h": max(highs[-24:]),
            "low_24h": min(lows[-24:]),
            "above_sma50_1h": ref > sma50,
            "ema20_above_ema50": ema20 > ema50,
            "macd_hist_1h": round(macd_hist / ref * 100, 3) if macd_hist is not None and ref else None,  # % of price, closed candles
            "bb_pos_1h": round(min(max(bb_pos, -0.5), 1.5), 2),   # 0 = lower band, 1 = upper band
            "vol_ratio_24h": round(vol_ratio, 2) if vol_ratio else None,
        }

    def fast_stats(self, coin: str) -> Dict:
        """15m frame over the last 24h for fast coins (midcaps/movers/open positions): entry TIMING only.
        Closed candles only (same rule as the 1h states) so values change at most once per 15 minutes."""
        end = int(time.time() * 1000)
        start = end - 24 * 3600 * 1000
        try:
            candles = self.info.candles_snapshot(coin, "15m", start, end)
        except Exception as e:
            log.warning(f"fast candles {coin}: {e}")
            return {}
        if len(candles) < 30:
            return {}
        partial = _f(candles[-1].get("T"), 0) > time.time() * 1000
        live = candles[-1] if partial else None
        if partial:
            candles = candles[:-1]
        closes = [_f(k["c"]) for k in candles]
        highs = [_f(k["h"]) for k in candles]
        lows = [_f(k["l"]) for k in candles]
        last = closes[-1]
        trs = [max(h - l, abs(h - closes[i - 1]), abs(l - closes[i - 1])) for i, (h, l) in enumerate(zip(highs, lows)) if i > 0]
        atr = sum(trs[-14:]) / min(14, len(trs)) if trs else 0
        ema20, ema50 = _ema(closes, 20)[-1], _ema(closes, 50)[-1]
        sma20 = sum(closes[-20:]) / min(20, len(closes))
        trend = "up" if (ema20 > ema50 and last > sma20) else "down" if (ema20 < ema50 and last < sma20) else "mixed"
        vols = [_f(k["v"]) for k in candles]
        burst = (sum(vols[-4:]) / 4) / (sum(vols) / len(vols)) if vols and sum(vols) else None  # last hour vs 24h avg
        out = {
            "trend_15m": trend,
            "rsi14_15m": _rsi(closes),
            "atr14_15m_pct": round(atr / last * 100, 2) if last else None,
            "vol_burst_15m": round(burst, 2) if burst else None,
        }
        if live:   # the CURRENT unconfirmed 15m candle: scalp timing info for the prompt only - never in states/gating
            lo, lh, ll, lc, lv = _f(live["o"]), _f(live["h"]), _f(live["l"]), _f(live["c"]), _f(live["v"])
            avg_v = sum(vols[-16:]) / min(16, len(vols)) if vols else 0
            out["live_15m"] = {
                "o": lo, "h": lh, "l": ll, "last": lc,
                "chg_pct": round((lc / lo - 1) * 100, 2) if lo else None,
                "mins_left": max(0, round(_f(live.get("T"), 0) / 1000 - time.time()) // 60),
                "vol_vs_avg": round(lv / avg_v, 2) if avg_v else None,
            }
        return out

    # ------------------------------------------------------------------- spot
    def spot_overview(self) -> Dict[str, Dict]:
        try:
            smeta, ctxs = self.info.spot_meta_and_asset_ctxs()
        except Exception as e:
            log.warning(f"spot meta: {e}")
            return {}
        tokens = {t["index"]: t for t in smeta["tokens"]}
        out: Dict[str, Dict] = {}
        for u, c in zip(smeta["universe"], ctxs):
            t0, t1 = u["tokens"]
            pair = f"{tokens[t0]['name']}/{tokens[t1]['name']}"
            self._spot_internal_name[pair] = u["name"]
            self.sz_decimals[u["name"]] = int(tokens[t0].get("szDecimals", 2))
            if pair not in self.cfg.universe.spot:
                continue
            mark = _f(c.get("markPx"))
            out[pair] = {
                "mark": mark,
                "mid": _f(c.get("midPx"), mark),
                "chg_24h_pct": _pct(mark, _f(c.get("prevDayPx"))),
                "vol_24h_usd": round(_f(c.get("dayNtlVlm"))),
                "internal_name": u["name"],
            }
        return out

    def spot_internal_name(self, pair: str) -> str:
        if not self._spot_internal_name:
            self.spot_overview()
        return self._spot_internal_name.get(pair, pair)

    # ----------------------------------------------------------- prediction mkts
    def polymarket_markets(self) -> List[Dict]:
        pm = self.cfg.universe.prediction_markets
        if not pm.enabled:
            return []
        now = datetime.now(timezone.utc)
        params = {
            "active": "true",
            "closed": "false",
            "limit": 200,
            "order": "volume24hr",
            "ascending": "false",
            "end_date_min": now.isoformat(),
            "end_date_max": (now + timedelta(days=pm.max_days_to_resolution)).isoformat(),
        }
        try:
            r = httpx.get(f"{GAMMA}/markets", params=params, timeout=20)
            r.raise_for_status()
            raw = r.json()
        except Exception as e:
            log.warning(f"polymarket gamma: {e}")
            return []
        out = []
        for m in raw:
            liq = _f(m.get("liquidityNum") or m.get("liquidity"))
            if liq < pm.min_liquidity_usd:
                continue
            try:
                outcomes = json.loads(m.get("outcomes") or "[]")
                prices = [round(_f(p), 3) for p in json.loads(m.get("outcomePrices") or "[]")]
                token_ids = json.loads(m.get("clobTokenIds") or "[]")
            except json.JSONDecodeError:
                continue
            if len(outcomes) != len(token_ids) or not token_ids:
                continue
            # skip markets that are effectively decided (no edge left) or about to resolve
            if not prices or max(prices) >= 0.95 or min(prices) <= 0.05:
                continue
            try:
                ends_in_h = (datetime.fromisoformat(m["endDate"].replace("Z", "+00:00")) - now).total_seconds() / 3600
                if ends_in_h < 1:
                    continue
            except Exception:
                pass
            out.append({
                "market_id": str(m.get("id")),
                "condition_id": m.get("conditionId"),
                "question": m.get("question"),
                "ends": (m.get("endDate") or "")[:10],
                "ends_iso": m.get("endDate"),
                "liq_kusd": round(liq / 1e3),
                "outcomes": [
                    {"outcome": o, "price": p, "token_id": t} for o, p, t in zip(outcomes, prices, token_ids)
                ],
            })
        # rank: preferred (crypto-related) questions first - the model has live price data for those - then by volume order
        kws = [k.lower() for k in pm.prefer_keywords]
        pref = [x for x in out if any(k in (x["question"] or "").lower() for k in kws)]
        rest = [x for x in out if x not in pref]
        n_pref = min(len(pref), max(pm.min_preferred, pm.max_markets_shown - len(rest)))
        chosen = pref[:n_pref] + rest[:pm.max_markets_shown - n_pref]
        return chosen[:pm.max_markets_shown]

    # ------------------------------------------------------------------ bundle
    def prices(self, perps: Dict[str, Dict], spot: Dict[str, Dict], pms: List[Dict]) -> Dict[str, float]:
        px: Dict[str, float] = {}
        for k, v in perps.items():
            px[k] = v["mid"] or v["mark"]
        for k, v in spot.items():
            px[k] = v["mid"] or v["mark"]
        for m in pms:
            for o in m["outcomes"]:
                px[o["token_id"]] = o["price"]
        return px

    def all_mids(self) -> Dict[str, float]:
        try:
            return {k: _f(v) for k, v in self.info.all_mids().items()}
        except Exception as e:
            log.warning(f"all_mids: {e}")
            return {}

    def gather(self, fast_extra: Optional[set] = None) -> Dict:
        perps = self.perp_overview()
        prev_oi = getattr(self, "_prev_oi", {})
        for coin in perps:
            perps[coin].update(self.candle_stats(coin))
            if coin in prev_oi and prev_oi[coin]:
                perps[coin]["oi_chg_pct_since_last"] = round((perps[coin]["oi_musd"] / prev_oi[coin] - 1) * 100, 2)
            bkt = self.cfg.universe.bucket_of(coin)
            if bkt in ("midcaps", "movers") or coin in (fast_extra or ()):   # fast 15m frame: timing, not signal-key input
                perps[coin].update(self.fast_stats(coin))
                t15 = perps[coin].get("trend_15m")
                t1h = "up" if (perps[coin].get("ema20_above_ema50") and perps[coin].get("above_sma50_1h")) else \
                      "down" if (perps[coin].get("ema20_above_ema50") is False and not perps[coin].get("above_sma50_1h")) else "mixed"
                if t15 in ("up", "down"):
                    perps[coin]["tf_align_15m"] = (t15 == t1h)
            perps[coin]["signal"] = _signal_summary(perps[coin])
            perps[coin]["_key"] = _signal_key(perps[coin])   # for the attention gate; stripped before the prompt
        self._prev_oi = {c: v["oi_musd"] for c, v in perps.items()}
        spot = self.spot_overview()
        # rolling beta to BTC from the last ~72 hourly returns (correlation x vol ratio); BTC itself = 1
        btc_r = (perps.get("BTC") or {}).get("_returns") or []
        for c, v in perps.items():
            r = v.pop("_returns", [])
            n = min(len(r), len(btc_r))
            if c == "BTC":
                v["beta_btc"] = 1.0
            elif n >= 24:
                rr_, bb_ = r[-n:], btc_r[-n:]
                mb = sum(bb_) / n; mr = sum(rr_) / n
                cov = sum((rr_[i] - mr) * (bb_[i] - mb) for i in range(n)) / n
                var = sum((x - mb) ** 2 for x in bb_) / n
                v["beta_btc"] = round(cov / var, 2) if var else 1.0
            else:
                v["beta_btc"] = 1.0
        pms = self.polymarket_markets()
        prices = self.prices(perps, spot, pms)
        # cache PM prices/questions: the 60s watch loop only has Hyperliquid mids, so it reuses these (<=5 min old)
        self.last_pm_prices = {o["token_id"]: o["price"] for m in pms for o in m["outcomes"]}
        self.pm_questions = {m["market_id"]: m["question"] for m in pms}
        self.pm_meta = {m["market_id"]: {"question": m["question"], "ends": m.get("ends_iso") or m.get("ends")} for m in pms}
        # 77-digit token ids waste ~500 tokens per call and invite transcription errors: show short codes instead
        tid_map: Dict[str, str] = {}
        n = 0
        for m in pms:
            for o in m["outcomes"]:
                n += 1
                code = f"T{n}"
                tid_map[code] = o["token_id"]
                o["tid"] = code
                del o["token_id"]
            m.pop("condition_id", None)
            m.pop("ends_iso", None)
        return {
            "ts_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "perps": perps,
            "spot": spot,
            "prediction_markets": pms,
            "_prices": prices,
            "_pm_tokens": tid_map,
        }


# ----------------------------------------------------------------------------- PM helpers
_STRIKE_RE = re.compile(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k|K)?")
_COIN_WORDS = {"bitcoin": "BTC", "btc": "BTC", "ethereum": "ETH", "eth": "ETH", "solana": "SOL", "sol": "SOL", "xrp": "XRP",
               "dogecoin": "DOGE", "doge": "DOGE", "hype": "HYPE", "hyperliquid": "HYPE", "sui": "SUI", "bnb": "BNB"}


def parse_price_market(question: str):
    """('BTC', 80000.0) for questions like 'Will the price of Bitcoin be above $80,000 on August 27?'; None otherwise."""
    q = (question or "").lower()
    coin = next((c for w, c in _COIN_WORDS.items() if re.search(rf"\b{w}\b", q)), None)
    m = _STRIKE_RE.search(question or "")
    if not coin or not m:
        return None
    val = float(m.group(1).replace(",", ""))
    if m.group(2):
        val *= 1000
    return coin, val


def hours_to(ends_iso: str) -> float:
    try:
        dt = datetime.fromisoformat(ends_iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (dt - datetime.now(timezone.utc)).total_seconds() / 3600
    except Exception:
        return 1e9


def pm_final_price(market_id: str, token_id: str):
    """Final price of an outcome token once its market has closed (1.0 / 0.0), else None."""
    try:
        r = httpx.get(f"{GAMMA}/markets/{market_id}", timeout=15)
        r.raise_for_status()
        m = r.json()
        prices = [float(p) for p in json.loads(m.get("outcomePrices") or "[]")]
        tids = json.loads(m.get("clobTokenIds") or "[]")
        if token_id in tids and prices:
            px = prices[tids.index(token_id)]
            if m.get("closed") or px >= 0.995 or px <= 0.005:
                return 1.0 if px >= 0.5 else 0.0
    except Exception as e:
        log.warning(f"pm_final_price {market_id}: {e}")
    return None


def pm_live_prices(market_ids):
    """Current outcome prices for a few markets (one gamma call each) - used by the 60s watch for held tokens."""
    out = {}
    for mid in set(market_ids):
        try:
            r = httpx.get(f"{GAMMA}/markets/{mid}", timeout=10)
            r.raise_for_status()
            m = r.json()
            for tid, px in zip(json.loads(m.get("clobTokenIds") or "[]"), json.loads(m.get("outcomePrices") or "[]")):
                out[tid] = float(px)
        except Exception as e:
            log.warning(f"pm_live_prices {mid}: {e}")
    return out
