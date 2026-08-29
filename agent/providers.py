"""
Pluggable LLM providers. Each returns a JSON object matching a schema, plus token usage.

  provider: anthropic | gemini | openai
  gemini  - Google AI Studio key (free tier available)     GEMINI_API_KEY
  openai  - platform.openai.com pay-as-you-go key          OPENAI_API_KEY   (ChatGPT subscriptions do NOT include this)
  anthropic - console.anthropic.com pay-as-you-go key      ANTHROPIC_API_KEY
"""
from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from .notify import log

logging.getLogger("google_genai").setLevel(logging.WARNING)   # silence per-request INFO noise
logging.getLogger("httpx").setLevel(logging.WARNING)


@dataclass
class Usage:
    input: int = 0
    output: int = 0
    cache_read: int = 0

    def add(self, other: "Usage") -> None:
        self.input += other.input
        self.output += other.output
        self.cache_read += other.cache_read

    def as_dict(self) -> Dict[str, int]:
        return {"input": self.input, "output": self.output, "cache_read": self.cache_read}


@dataclass
class Completion:
    data: Optional[Dict[str, Any]]
    raw: str
    usage: Usage = field(default_factory=Usage)
    error: str = ""


def _strip_keys(schema: Dict, drop: set) -> Dict:
    """Remove JSON-schema keywords a provider doesn't accept."""
    s = copy.deepcopy(schema)

    def walk(node):
        if isinstance(node, dict):
            for k in list(node.keys()):
                if k in drop:
                    node.pop(k)
                else:
                    walk(node[k])
        elif isinstance(node, list):
            for x in node:
                walk(x)
    walk(s)
    return s


class Provider:
    name = "base"

    def __init__(self, model: str, api_key: str, max_tokens: int, temperature: float, thinking: str = "minimal"):
        self.model, self.api_key, self.max_tokens, self.temperature = model, api_key, max_tokens, temperature
        self.thinking = thinking   # none | minimal | low | medium | high  (Gemini only; others ignore)

    def complete(self, system: str, user: str, schema: Dict, tool_name: str = "submit") -> Completion:  # pragma: no cover
        raise NotImplementedError

    def ping(self) -> str:
        c = self.complete("Reply with JSON.", "Return {\"ok\": true}.", {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]})
        if c.error:
            raise RuntimeError(c.error)
        return f"{self.name}:{self.model} responded ({c.usage.input} in / {c.usage.output} out tokens)"


class AnthropicProvider(Provider):
    name = "anthropic"

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        import anthropic
        self.client = anthropic.Anthropic(api_key=self.api_key)

    def complete(self, system, user, schema, tool_name="submit") -> Completion:
        try:
            resp = self.client.messages.create(
                model=self.model, max_tokens=self.max_tokens, temperature=self.temperature,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                tools=[{"name": tool_name, "description": "Submit the structured result.", "input_schema": schema}],
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": user}],
            )
            u = resp.usage
            usage = Usage(u.input_tokens + (getattr(u, "cache_creation_input_tokens", 0) or 0), u.output_tokens,
                          getattr(u, "cache_read_input_tokens", 0) or 0)
            tu = next((b for b in resp.content if b.type == "tool_use"), None)
            if not tu:
                return Completion(None, "", usage, "no tool call in response")
            return Completion(dict(tu.input), json.dumps(tu.input), usage)
        except Exception as e:
            return Completion(None, "", Usage(), f"anthropic error: {e}")


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        from google import genai
        from google.genai import types as _t
        self.client = genai.Client(api_key=self.api_key, http_options=_t.HttpOptions(timeout=25_000))  # 25s: a slow call must not stall the loop

    def complete(self, system, user, schema, tool_name="submit") -> Completion:
        from google.genai import types
        cfg = dict(
            system_instruction=system,
            temperature=self.temperature,
            # thinking tokens count against this budget on models that think; give plenty of room so the
            # JSON answer is never truncated (we pay only for what is generated, not for the cap)
            max_output_tokens=max(self.max_tokens, 8192),
            response_mime_type="application/json",
            response_json_schema=_strip_keys(schema, {"additionalProperties"}),
        )
        # Thinking costs output tokens ($3.75/M on 3.x Flash): the proposer runs every cycle so it defaults to "minimal"
        # (0 thought tokens on 3.6 Flash); the verifier may reason ("low"). Fallback order = cheapest accepted setting.
        ladder = {"none": ["budget0", "minimal", "low", None], "minimal": ["minimal", "budget0", "low", None],
                  "low": ["low", "minimal", None], "medium": ["medium", "low", None], "high": ["high", "medium", None]}
        def _tc(name):
            if name is None: return None
            if name == "budget0": return types.ThinkingConfig(thinking_budget=0)
            return types.ThinkingConfig(thinking_level=name)
        attempts = [_tc(n) for n in ladder.get(self.thinking, ladder["minimal"])]
        try:
            resp = None
            last = None
            for tc in attempts:
                try:
                    conf = types.GenerateContentConfig(thinking_config=tc, **cfg) if tc is not None else types.GenerateContentConfig(**cfg)
                    resp = self.client.models.generate_content(model=self.model, contents=user, config=conf)
                    break
                except Exception as e:
                    last = e
                    msg = str(e).lower()
                    if "thinking" not in msg and "invalid_argument" not in msg and "400" not in msg:
                        raise
            if resp is None:
                raise last
            um = resp.usage_metadata
            usage = Usage((um.prompt_token_count or 0) - (um.cached_content_token_count or 0),
                          (um.candidates_token_count or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
                          um.cached_content_token_count or 0) if um else Usage()
            text = resp.text or ""
            fr = str(resp.candidates[0].finish_reason) if resp.candidates else "no candidates"
            if not text:
                return Completion(None, "", usage, f"gemini returned empty text (finish_reason={fr})")
            try:
                return Completion(json.loads(text), text, usage)
            except json.JSONDecodeError as e:
                return Completion(None, text, usage, f"gemini returned non-JSON ({fr}, {len(text)} chars): {e}")
        except Exception as e:
            return Completion(None, "", Usage(), f"gemini error: {e}")


class OpenAIProvider(Provider):
    name = "openai"

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        import openai
        self.client = openai.OpenAI(api_key=self.api_key)

    def complete(self, system, user, schema, tool_name="submit") -> Completion:
        try:
            kwargs: Dict[str, Any] = dict(
                model=self.model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                response_format={"type": "json_schema", "json_schema": {"name": tool_name, "schema": schema, "strict": False}},
            )
            # newer reasoning models reject temperature / max_tokens; try full, then minimal
            try:
                resp = self.client.chat.completions.create(temperature=self.temperature, max_completion_tokens=self.max_tokens, **kwargs)
            except Exception as e:
                if "temperature" in str(e) or "max_completion_tokens" in str(e) or "unsupported" in str(e).lower():
                    resp = self.client.chat.completions.create(**kwargs)
                else:
                    raise
            u = resp.usage
            cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
            usage = Usage((u.prompt_tokens or 0) - cached, u.completion_tokens or 0, cached)
            text = resp.choices[0].message.content or ""
            try:
                return Completion(json.loads(text), text, usage)
            except json.JSONDecodeError as e:
                return Completion(None, text, usage, f"openai returned non-JSON: {e}")
        except Exception as e:
            return Completion(None, "", Usage(), f"openai error: {e}")


class OpenRouterProvider(OpenAIProvider):
    """OpenRouter (openrouter.ai): one key, many vendors (x-ai/grok, deepseek, ...), OpenAI-compatible."""
    name = "openrouter"

    def __init__(self, *a, **k):
        Provider.__init__(self, *a, **k)
        import openai
        self.client = openai.OpenAI(api_key=self.api_key, base_url="https://openrouter.ai/api/v1")


PROVIDERS = {"anthropic": AnthropicProvider, "gemini": GeminiProvider, "openai": OpenAIProvider, "openrouter": OpenRouterProvider}


def make_provider(name: str, model: str, api_key: Optional[str], max_tokens: int, temperature: float, thinking: str = "minimal") -> Provider:
    if name not in PROVIDERS:
        raise SystemExit(f"unknown llm provider {name!r}; choose one of {list(PROVIDERS)}")
    if not api_key:
        env = {"anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY"}[name]
        raise SystemExit(f"{env} is not set in .env (required for provider {name!r})")
    log.info(f"llm provider {name}:{model} thinking={thinking}")
    return PROVIDERS[name](model, api_key, max_tokens, temperature, thinking)
