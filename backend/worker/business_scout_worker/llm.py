"""Authored by: Mohit Singh

Tier-3 (optional) AI extraction — a provider-agnostic OpenAI-compatible chat-completions client.
Works unmodified against Gemini's OpenAI-compat endpoint, OpenAI itself, or a local Ollama server —
swapping providers is an env change (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL), never a code change. See
md/plans/0001-*.md "Phase 5 — AI extraction tier".

Design constraints (enforced here, not by callers):
  - Off by default: `enabled=False` (mirrors crawl_settings.use_ai_extraction) or a missing
    `base_url` short-circuits to None without ever touching the network.
  - Structured JSON output, pydantic-validated, ONE retry (mirrors the plan's "JSON schema ·
    retries on 429") — a still-invalid response after the retry returns None rather than raising,
    since one bad field must never fail the whole business's enrichment (see pipeline.py's
    existing "one bad site must not abort the whole job" pattern).
  - Per-(domain, field_key, prompt) cache for the daemon process's lifetime — a job that crawls
    many businesses sharing a domain, or the same prompt run again, doesn't re-spend LLM calls on
    an identical extraction.
"""

from __future__ import annotations

import json
import re
from typing import Any, cast
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, ValidationError

from business_scout_worker.logging_config import get_logger
from business_scout_worker.models import DynamicFieldType

logger = get_logger(__name__)

MAX_PAGE_TEXT_CHARS = 6000
"""Caps the input text sent to the LLM — bounds token usage and avoids forwarding an entire
scraped page (megabytes for some sites). Enough for a homepage + one contact page's worth of
prose to answer a well-scoped extraction prompt."""

MAX_RETRIES = 1
"""One retry after the initial attempt, per the plan's "JSON schema · retries on 429"."""

_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)

_cache: dict[tuple[str, str, str], Any] = {}
"""(domain, field_key, prompt) -> extracted value (already coerced) or None. Process-lifetime
only — a fresh daemon restart clears it; that's a cost optimization, not a correctness guarantee."""


class _ExtractionResult(BaseModel):
    value: Any = None


def clear_cache() -> None:
    """Test-only escape hatch so tests don't leak cached values across cases."""
    _cache.clear()


def domain_of(url: str) -> str:
    return (urlparse(url).netloc or url).lower().removeprefix("www.")


def _coerce(value: Any, field_type: DynamicFieldType) -> Any | None:
    if value is None:
        return None
    try:
        if field_type == "text":
            text = str(value).strip()
            return text or None
        if field_type == "url":
            text = str(value).strip()
            return text if text.startswith(("http://", "https://")) else None
        if field_type == "number":
            return float(value)
        if field_type == "boolean":
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in {"true", "yes", "1"}
        if field_type == "list":
            if isinstance(value, list):
                items = [str(v).strip() for v in value if str(v).strip()]
                return items or None
            text = str(value).strip()
            return [text] if text else None
    except (TypeError, ValueError):
        return None
    return None


def _extract_json_object(text: str) -> dict[str, Any] | None:
    try:
        return cast("dict[str, Any]", json.loads(text))
    except json.JSONDecodeError:
        pass
    match = _JSON_BLOCK_RE.search(text)
    if match is None:
        return None
    try:
        return cast("dict[str, Any]", json.loads(match.group(0)))
    except json.JSONDecodeError:
        return None


async def _call_chat_completions(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    prompt: str,
    max_tokens: int,
) -> str | None:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You extract exactly one field from a business's website text. Reply with "
                    'ONLY a JSON object of the form {"value": <the extracted value, or null if '
                    "not found>}. No prose, no markdown fences."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    resp = await client.post(
        f"{base_url.rstrip('/')}/chat/completions", json=payload, headers=headers
    )
    resp.raise_for_status()
    body = resp.json()
    choices = body.get("choices") or []
    if not choices:
        return None
    message = choices[0].get("message") or {}
    content = message.get("content")
    return content if isinstance(content, str) else None


async def extract_field(
    *,
    enabled: bool,
    base_url: str | None,
    api_key: str | None,
    model: str,
    timeout_s: float,
    max_tokens: int,
    domain: str,
    page_text: str,
    field_key: str,
    field_type: DynamicFieldType,
    prompt: str,
    client: httpx.AsyncClient | None = None,
) -> Any | None:
    """Best-effort — never raises. Returns None when: disabled, no `base_url` configured, or any
    HTTP/parse/validation failure survives the retry. The caller (pipeline.py) writes whatever
    comes back (including None) into `businesses.extras.{field_key}`."""
    if not enabled or not base_url:
        return None

    cache_key = (domain, field_key, prompt)
    if cache_key in _cache:
        return _cache[cache_key]

    trimmed_text = page_text[:MAX_PAGE_TEXT_CHARS]
    full_prompt = f"{prompt}\n\n---\nWebsite text:\n{trimmed_text}"

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=timeout_s)
    value: Any = None
    try:
        for attempt in range(MAX_RETRIES + 1):
            try:
                raw = await _call_chat_completions(
                    client,
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    prompt=full_prompt,
                    max_tokens=max_tokens,
                )
            except httpx.HTTPError as exc:
                logger.warning(
                    "llm_request_failed", field_key=field_key, attempt=attempt, error=str(exc)
                )
                continue
            if raw is None:
                continue
            parsed = _extract_json_object(raw)
            if parsed is None:
                continue
            try:
                result = _ExtractionResult.model_validate(parsed)
            except ValidationError:
                continue
            value = _coerce(result.value, field_type)
            break
    finally:
        if owns_client:
            await client.aclose()

    _cache[cache_key] = value
    return value
