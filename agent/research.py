"""Grounded web research for NON-crypto prediction markets (sports/politics/macro).

Crypto price markets use the agent's live Hyperliquid price data - no search needed. For everything else the
agent has no information, so a cheap grounded Gemini call (Google Search) estimates the probability before it bets.
Results are cached per market for research_cache_hours; a small per-cycle count and a daily USD budget cap the cost.
"""
from __future__ import annotations

import json
import re
import time
from typing import Dict, List, Optional

from .config import Config
from .market_data import parse_price_market
from .notify import log
from .state import State

_JSON = re.compile(r"\{.*\}", re.S)


class Researcher:
    def __init__(self, cfg: Config, state: State):
        self.cfg = cfg
        self.pm = cfg.universe.prediction_markets
        self.state = state
        self.cache: Dict[str, Dict] = state.get("pm_research", {})
        self._client = None
        self.last_cost = 0.0

    def _gemini(self):
        if self._client is None:
            from google import genai
            from google.genai import types
            self._client = genai.Client(api_key=self.cfg.gemini_api_key, http_options=types.HttpOptions(timeout=20_000))
            self._types = types
        return self._client

    def _price_of(self, model: str) -> List[float]:
        return (self.cfg.llm.prices.get(model) or [0.3, 2.5])[:2]

    def _research_one(self, market: Dict) -> Optional[Dict]:
        types = self._types if self._client else __import__("google.genai", fromlist=["types"]).types
        client = self._gemini()
        q = (f"Prediction market question: \"{market['question']}\" (resolves {market.get('ends')}). "
             "Search the web for the latest facts and estimate the probability the answer is YES. "
             "Reply ONLY a JSON object: {\"prob_yes\": 0..1, \"confidence\": 0..1, \"summary\": \"one sentence with the key fact and date\"}.")
        try:
            r = client.models.generate_content(
                model=self.pm.research_model, contents=q,
                config=self._types.GenerateContentConfig(tools=[self._types.Tool(google_search=self._types.GoogleSearch())],
                                                         temperature=0.2, max_output_tokens=1200))
            um = r.usage_metadata
            pin, pout = self._price_of(self.pm.research_model)
            self.last_cost += ((um.prompt_token_count or 0) * pin + (um.candidates_token_count or 0) * pout) / 1e6
            m = _JSON.search(r.text or "")
            if not m:
                return None
            d = json.loads(m.group(0))
            gm = r.candidates[0].grounding_metadata if r.candidates and r.candidates[0].grounding_metadata else None
            return {"prob_yes": float(d.get("prob_yes")), "confidence": float(d.get("confidence", 0.5)),
                    "summary": str(d.get("summary", ""))[:300],
                    "searched": list(getattr(gm, "web_search_queries", []) or []) if gm else [], "ts": time.time()}
        except Exception as e:
            log.warning(f"research '{market.get('question','')[:40]}': {e}")
            return None

    def verify(self, market: Dict, claimed_prob: float, outcome: str) -> Optional[Dict]:
        """Second, skeptical grounded search to double-check an implausibly large edge before rejecting it.
        Returns {prob_yes, confidence, agree, verified_outcome, summary} or None. Costs one Flash-Lite search."""
        if not (self.pm.research_enabled and self.cfg.gemini_api_key):
            return None
        day = time.strftime("%Y-%m-%d", time.gmtime())
        spent = self.state.get("research_today") or {"day": day, "usd": 0.0}
        if spent.get("day") != day:
            spent = {"day": day, "usd": 0.0}
        if spent["usd"] >= self.pm.research_max_usd_per_day:
            return None
        self.last_cost = 0.0
        client = self._gemini()
        q = (f"Double-check with the latest web sources. Market: \"{market.get('question')}\" (resolves {market.get('ends')}). "
             f"Someone estimates the '{outcome}' outcome wins with probability {claimed_prob:.0%}, but the market prices it far lower. "
             f"Verify: the exact event and date, and which side '{outcome}' actually refers to. Then give YOUR independent probability. "
             "Reply ONLY JSON: {{\"prob_yes\": 0..1, \"confidence\": 0..1, \"verified_outcome\": true/false (did you confirm which side "
             "the outcome is), \"agree\": true/false (does your estimate support a probability at least this high), \"summary\": \"one sentence with the source/date\"}}.")
        try:
            r = client.models.generate_content(
                model=self.pm.research_model, contents=q,
                config=self._types.GenerateContentConfig(tools=[self._types.Tool(google_search=self._types.GoogleSearch())],
                                                         temperature=0.1, max_output_tokens=1200))
            um = r.usage_metadata
            pin, pout = self._price_of(self.pm.research_model)
            self.last_cost += ((um.prompt_token_count or 0) * pin + (um.candidates_token_count or 0) * pout) / 1e6
            spent["usd"] = round(spent["usd"] + self.last_cost, 5)
            self.state.set("research_today", spent)
            m = _JSON.search(r.text or "")
            if not m:
                return None
            d = json.loads(m.group(0))
            return {"prob_yes": float(d.get("prob_yes")), "confidence": float(d.get("confidence", 0.5)),
                    "verified_outcome": bool(d.get("verified_outcome")), "agree": bool(d.get("agree")),
                    "summary": str(d.get("summary", ""))[:300]}
        except Exception as e:
            log.warning(f"verify '{market.get('question','')[:40]}': {e}")
            return None

    def annotate(self, pms: List[Dict]) -> None:
        """Attach a `research` note to non-crypto markets (from cache; research a few fresh ones within budget)."""
        if not (self.pm.research_enabled and self.cfg.gemini_api_key):
            return
        self.last_cost = 0.0
        day = time.strftime("%Y-%m-%d", time.gmtime())
        spent = self.state.get("research_today") or {"day": day, "usd": 0.0}
        if spent.get("day") != day:
            spent = {"day": day, "usd": 0.0}
        budget_left = self.pm.research_max_usd_per_day - spent["usd"]
        done = 0
        for m in pms:
            if parse_price_market(m["question"]):          # crypto price market -> live data, skip search
                continue
            mid = str(m["market_id"])
            cached = self.cache.get(mid)
            if cached and time.time() - cached["ts"] < self.pm.research_cache_hours * 3600:
                m["research"] = {k: cached[k] for k in ("prob_yes", "confidence", "summary")}
                continue
            if done >= self.pm.research_per_cycle or budget_left - self.last_cost <= 0:
                continue
            res = self._research_one(m)
            done += 1
            if res:
                self.cache[mid] = res
                m["research"] = {k: res[k] for k in ("prob_yes", "confidence", "summary")}
                log.info(f"[dim]researched '{m['question'][:45]}' -> P(yes)={res['prob_yes']:.2f} conf {res['confidence']:.2f}[/]")
        if self.last_cost:
            spent["usd"] = round(spent["usd"] + self.last_cost, 5)
            self.state.set("research_today", spent)
            self.cache = {k: v for k, v in self.cache.items() if time.time() - v["ts"] < 48 * 3600}
            self.state.set("pm_research", self.cache)
