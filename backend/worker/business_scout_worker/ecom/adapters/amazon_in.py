"""Authored by: Mohit Singh

amazon.in adapter. Amazon runs the same storefront software on every marketplace, so the card
selectors, pagination (`&page=N`), sort params (`s=review-rank` / `price-asc-rank` /
`price-desc-rank`), CAPTCHA wall and detail-page markup are all shared with the amazon.ae adapter
(see amazon.py) — this subclass overrides only what genuinely differs per marketplace: the host,
the `language=` locale, the currency (INR), and the registry key.

Its own registry key (`amazon_in`) — never folded into `amazon` — keeps the existing amazon.ae
rows/jobs valid and lets each marketplace be launched, queued and exported on its own.

Unlike amazon.ae it is `REQUIRES_CDP`: amazon.in answered the headless container browser with
HTTP 503 ("It's rush hour and traffic is piling up") on every attempt (3/3, 2026-11-15), while the
operator's own real Chrome is the established way past such an edge for noon. So amazon_in jobs are
skipped by the container daemon and claimed only by the host runner (run_noon_host.py) attached over
CDP to that Chrome — the operator chose this explicitly. No header/user-agent/timezone spoofing is
involved or wanted: the real browser is simply used as-is.
"""

from __future__ import annotations

from typing import ClassVar

from business_scout_worker.ecom.adapters.amazon import AmazonAdapter

BASE_URL = "https://www.amazon.in"


class AmazonInAdapter(AmazonAdapter):
    platform: ClassVar[str] = "amazon_in"
    default_currency: ClassVar[str] = "INR"
    base_url: ClassVar[str] = BASE_URL
    language: ClassVar[str] = "en_IN"
    REQUIRES_CDP: ClassVar[bool] = True
    # Every amazon.in row is DOM-sourced (sources={'dom': N}; OCR never runs on them), so the
    # per-card scroll+screenshot only produced audit PNGs — and, in the visible real Chrome, the
    # flicker the operator reported as "the page keeps refreshing". Skipped: same data, no
    # scrolling, much faster.
    CARD_SCREENSHOTS: ClassVar[bool] = False
