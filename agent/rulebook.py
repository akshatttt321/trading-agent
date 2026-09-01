"""RULE BOOK: a fully deterministic Freqtrade-style strategy running in parallel with the LLM book on its own
virtual $300 - same venue prices, same fee model, zero LLM cost. Purpose: A/B the two architectures live.
Strategy (backtested): trend-aligned pullback - ema20>ema50 & close>sma50 (1h, closed candles), price pulls back
to ema20, RSI 35-65 -> limit at ema20 (3h TTL), stop 1.5xATR, TP at RR_MULT, 48h time stop. Shorts mirrored."""
import time
import logging

log = logging.getLogger("agent")

ATR_MULT = 1.5
RR_MULT = 2.0            # backtest winner: V0 pullback @2.0R TP on the mover subset (+8.6R/483t, 75d)
RISK_PCT = 5.0           # % of rule-book equity risked per trade
MAX_POS = 6
MAX_NOTIONAL_X = 2.0     # per-position notional cap vs book equity
FEE_IN, FEE_OUT = 0.00015, 0.00125
LIMIT_TTL_H, TIME_STOP_H = 3, 48


def _ema(xs, n):
    k = 2 / (n + 1); out = [xs[0]]
    for x in xs[1:]:
        out.append(out[-1] + k * (x - out[-1]))
    return out


def _rsi(closes, n=14):
    if len(closes) <= n:
        return None
    g = l = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]; g += max(d, 0); l += max(-d, 0)
    ag, al = g / n, l / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n; al = (al * (n - 1) + max(-d, 0)) / n
    return 100 - 100 / (1 + (ag / al if al else 1e9))


class RuleBook:
    def __init__(self, cfg, state, md):
        self.cfg, self.state, self.md = cfg, state, md

    def _book(self):
        b = self.state.get("rule_book")
        if not b:
            b = {"cash": 300.0, "start": 300.0, "start_ts": time.time(), "positions": {},
                 "pending": [], "trades": [], "last_hour": 0}
            self.state.set("rule_book", b)
        return b

    def equity(self, prices):
        b = self._book(); eq = b["cash"]
        for c, p in b["positions"].items():
            px = prices.get(c) or p["entry"]
            sig = 1 if p["side"] == "long" else -1
            eq += p["notional"] * sig * (px - p["entry"]) / p["entry"]
        return eq

    def hourly(self, prices):
        """Run once per closed 1h candle: manage fills/stops on candle extremes, then scan for new signals."""
        b = self._book()
        hour = int(time.time() // 3600)
        if hour == b.get("last_hour"):
            return
        b["last_hour"] = hour
        # BUCKETED UNIVERSE from the 12-strategy x 177-coin x 150d matrix (matrix.json):
        # BOTH = double-positive in pullback AND deepfade; *_ONLY = matched to their one proven style.
        # Selection stays in-sample-tuned - the strat-tagged live scoreboard is the out-of-sample judge.
        BOTH = ["ZRO", "ENA", "ALT", "HEMI", "HMSTR"]
        PB_ONLY = ["WLD", "FARTCOIN", "CRV", "COMP", "BABY"]
        DF_ONLY = ["kPEPE", "BRETT", "UNI", "MEGA", "NXPC"]
        PB_SET, DF_SET = set(BOTH + PB_ONLY), set(BOTH + DF_ONLY)
        coins = BOTH + PB_ONLY + DF_ONLY
        now = time.time()
        for coin in coins:
            try:
                end = int(now * 1000)
                ks = self.md.info.candles_snapshot(coin, "1h", end - 12 * 24 * 3600 * 1000, end)
                if not ks or len(ks) < 60:
                    continue
                if float(ks[-1].get("T") or 0) > now * 1000:      # drop the live partial candle
                    ks = ks[:-1]
                C = [float(k["c"]) for k in ks]; H = [float(k["h"]) for k in ks]; L = [float(k["l"]) for k in ks]
                last, hi, lo = C[-1], H[-1], L[-1]
                # ---- manage pending limit (fill on last closed candle) ----
                for pd in list(b["pending"]):
                    if pd["coin"] != coin:
                        continue
                    if now > pd["expires_ts"]:
                        b["pending"].remove(pd); continue
                    sig = 1 if pd["side"] == "long" else -1
                    if (sig == 1 and lo <= pd["limit"]) or (sig == -1 and hi >= pd["limit"]):
                        b["pending"].remove(pd)
                        if coin not in b["positions"] and len(b["positions"]) < MAX_POS:
                            b["cash"] -= pd["notional"] * FEE_IN
                            b["positions"][coin] = {"side": pd["side"], "strat": pd.get("strat", "pullback"), "entry": pd["limit"], "stop": pd["stop"],
                                                    "tp": pd["tp"], "notional": pd["notional"], "risk_usd": pd["risk_usd"],
                                                    "opened_ts": now, "deadline_ts": now + TIME_STOP_H * 3600}
                            log.info(f"[dim]RULE-BOOK fill: {pd['side']} {coin} @ {pd['limit']:.6g}[/]")
                # ---- manage open position on candle extremes (stop checked first: conservative) ----
                p = b["positions"].get(coin)
                if p:
                    sig = 1 if p["side"] == "long" else -1
                    exit_px = why = None
                    if (sig == 1 and lo <= p["stop"]) or (sig == -1 and hi >= p["stop"]):
                        exit_px, why = p["stop"], "stop"
                    elif (sig == 1 and hi >= p["tp"]) or (sig == -1 and lo <= p["tp"]):
                        exit_px, why = p["tp"], "tp"
                    elif now > p["deadline_ts"]:
                        exit_px, why = last, "time"
                    if exit_px is not None:
                        pnl = p["notional"] * sig * (exit_px - p["entry"]) / p["entry"] - p["notional"] * FEE_OUT
                        b["cash"] += pnl
                        r = pnl / p["risk_usd"] if p["risk_usd"] else 0
                        b["trades"].append({"coin": coin, "side": p["side"], "strat": p.get("strat", "pullback"), "entry": p["entry"], "exit": exit_px,
                                            "r": round(r, 2), "pnl": round(pnl, 2), "why": why, "ts": now})
                        del b["positions"][coin]
                        log.info(f"[dim]RULE-BOOK {why}: {p['side']} {coin} {r:+.2f}R (${pnl:+.2f})[/]")
                        continue
                # ---- new signal on the last closed candle ----
                if coin in b["positions"] or any(pd["coin"] == coin for pd in b["pending"]) or len(b["positions"]) >= MAX_POS:
                    continue
                e20, e50 = _ema(C, 20)[-1], _ema(C, 50)[-1]
                s50 = sum(C[-50:]) / min(50, len(C))
                rs = _rsi(C)
                trs = [max(H[i] - L[i], abs(H[i] - C[i - 1]), abs(L[i] - C[i - 1])) for i in range(1, len(C))]
                atr = sum(trs[-14:]) / min(14, len(trs))
                if not rs or not atr:
                    continue
                # two tagged signal streams, one position per coin:
                #   pullback (backtest +0.024R/t): touch of the EMA20 in trend, RSI 35-65, limit AT the EMA
                #   deepfade (backtest +0.124R/t): same trend, limit a FULL ATR beyond the EMA - patience is the edge
                side = None; strat = "pullback"; limit_px = e20
                if coin in PB_SET and 35 <= rs <= 65:
                    if e20 > e50 and last > s50 and lo <= e20 * 1.003 and last >= e20 * 0.997:
                        side = "long"
                    elif e20 < e50 and last < s50 and hi >= e20 * 0.997 and last <= e20 * 1.003:
                        side = "short"
                if not side and coin in DF_SET:
                    if e20 > e50 and last > s50 and rs < 45:
                        side, strat, limit_px = "long", "deepfade", e20 - 1.0 * atr
                    elif e20 < e50 and last < s50 and rs > 55:
                        side, strat, limit_px = "short", "deepfade", e20 + 1.0 * atr
                if not side:
                    continue
                eq = self.equity(prices)
                risk_usd = eq * RISK_PCT / 100
                risk_frac = ATR_MULT * atr / limit_px
                notional = min(risk_usd / risk_frac, eq * MAX_NOTIONAL_X)
                sig = 1 if side == "long" else -1
                b["pending"].append({"coin": coin, "side": side, "strat": strat, "limit": limit_px,
                                     "stop": limit_px - sig * ATR_MULT * atr,
                                     "tp": limit_px + sig * RR_MULT * ATR_MULT * atr, "notional": round(notional, 2),
                                     "risk_usd": round(notional * risk_frac, 2), "expires_ts": now + LIMIT_TTL_H * 3600})
                log.info(f"[dim]RULE-BOOK signal [{strat}]: {side} {coin} limit {limit_px:.6g} stop {limit_px - sig * ATR_MULT * atr:.6g}[/]")
            except Exception:
                log.exception(f"rule book {coin}")
        b["trades"] = b["trades"][-200:]
        eq = self.equity(prices)
        b["equity"] = round(eq, 2)                              # stamped for the dashboard
        for c, p_ in b["positions"].items():
            px = prices.get(c) or p_["entry"]
            sgn = 1 if p_["side"] == "long" else -1
            p_["mark"] = px
            p_["upnl"] = round(p_["notional"] * sgn * (px - p_["entry"]) / p_["entry"], 2)
        self.state.set("rule_book", b)
        log.info(f"[bold]RULE-BOOK[/] equity ${eq:,.2f} ({eq / b['start']:.3f}x) positions={len(b['positions'])} "
                 f"pending={len(b['pending'])} trades={len(b['trades'])}")
