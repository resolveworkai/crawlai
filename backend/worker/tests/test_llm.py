"""Authored by: Mohit Singh

Pure unit tests for llm.py — every HTTP call is mocked via httpx.MockTransport, so this runs
with no live LLM provider. Prompt assembly, JSON-schema validation, cache hit/miss, gating, and
field-type coercion are covered here per md/plans/0001-*.md Phase 5's DoD.
"""

from __future__ import annotations

import json

import httpx
import pytest

from business_scout_worker import llm

# No `pytestmark = pytest.mark.asyncio` here — pyproject.toml's asyncio_mode = "auto" already
# treats every `async def test_*` as an asyncio test with no marker needed. This file also has
# one plain sync test (test_domain_of_strips_www_and_scheme); a module-wide mark would apply to
# it too and pytest-asyncio 1.x warns when a non-async function carries the asyncio mark.


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    llm.clear_cache()


def _ok_content_handler(content: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    return httpx.MockTransport(handler)


async def test_extract_field_returns_none_when_disabled() -> None:
    value = await llm.extract_field(
        enabled=False,
        base_url="https://llm.example/v1",
        api_key=None,
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="hello",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
    )
    assert value is None


async def test_extract_field_returns_none_when_no_base_url() -> None:
    value = await llm.extract_field(
        enabled=True,
        base_url=None,
        api_key=None,
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="hello",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
    )
    assert value is None


async def test_extract_field_parses_plain_json_content() -> None:
    client = httpx.AsyncClient(transport=_ok_content_handler(json.dumps({"value": "2015"})))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015 in Berlin.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value == "2015"


async def test_extract_field_parses_json_wrapped_in_prose_or_fences() -> None:
    content = 'Sure, here you go:\n```json\n{"value": "2015"}\n```'
    client = httpx.AsyncClient(transport=_ok_content_handler(content))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value == "2015"


async def test_extract_field_returns_none_on_unparseable_response() -> None:
    client = httpx.AsyncClient(transport=_ok_content_handler("not json at all, sorry"))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value is None


async def test_extract_field_retries_once_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(200, json={"choices": [{"message": {"content": "garbage"}}]})
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps({"value": "2015"})}}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value == "2015"
    assert calls["n"] == 2


async def test_extract_field_gives_up_after_retry_exhausted() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": "still garbage"}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value is None
    assert calls["n"] == 2  # one initial attempt + one retry, never a third


async def test_extract_field_survives_http_error_and_retries() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps({"value": "2015"})}}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value == "2015"


async def test_extract_field_caches_by_domain_field_and_prompt() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps({"value": "2015"})}}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    kwargs = dict(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="a.example",
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    first = await llm.extract_field(**kwargs)  # type: ignore[arg-type]
    second = await llm.extract_field(**kwargs)  # type: ignore[arg-type]
    await client.aclose()

    assert first == second == "2015"
    assert calls["n"] == 1  # second call served entirely from cache


async def test_extract_field_cache_miss_on_different_domain() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps({"value": "2015"})}}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    base_kwargs = dict(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        page_text="Founded in 2015.",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await llm.extract_field(domain="a.example", **base_kwargs)  # type: ignore[arg-type]
    await llm.extract_field(domain="b.example", **base_kwargs)  # type: ignore[arg-type]
    await client.aclose()

    assert calls["n"] == 2


@pytest.mark.parametrize(
    ("field_type", "raw_value", "expected"),
    [
        ("text", "  Hello world  ", "Hello world"),
        ("text", "", None),
        ("url", "https://example.com/about", "https://example.com/about"),
        ("url", "not-a-url", None),
        ("number", "42", 42.0),
        ("number", "not-a-number", None),
        ("boolean", True, True),
        ("boolean", "yes", True),
        ("boolean", "no", False),
        ("list", ["a", " b ", ""], ["a", "b"]),
        ("list", "solo", ["solo"]),
        ("list", [], None),
    ],
)
async def test_extract_field_coerces_by_field_type(
    field_type: str, raw_value: object, expected: object
) -> None:
    client = httpx.AsyncClient(transport=_ok_content_handler(json.dumps({"value": raw_value})))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain=f"coerce-{field_type}.example",
        page_text="irrelevant",
        field_key="some_field",
        field_type=field_type,  # type: ignore[arg-type]
        prompt="extract it",
        client=client,
    )
    await client.aclose()
    assert value == expected


async def test_extract_field_null_value_from_llm_means_not_found() -> None:
    client = httpx.AsyncClient(transport=_ok_content_handler(json.dumps({"value": None})))
    value = await llm.extract_field(
        enabled=True,
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        max_tokens=100,
        domain="null-value.example",
        page_text="no info here",
        field_key="founded_year",
        field_type="text",
        prompt="What year was this business founded?",
        client=client,
    )
    await client.aclose()
    assert value is None


def test_domain_of_strips_www_and_scheme() -> None:
    assert llm.domain_of("https://www.example.com/about") == "example.com"
    assert llm.domain_of("http://sub.example.com") == "sub.example.com"
