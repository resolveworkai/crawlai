"""Authored by: Mohit Singh

Builds a `wa.me` deep link with a custom, listing-specific message — the actual point of the
detail-page phone reveal (see property/adapters/*.extract_detail). Never sends anything itself;
the operator clicks the link in their own browser/WhatsApp, same trust boundary as noon/AliExpress's
CDP-attach-to-the-operator's-own-Chrome pattern elsewhere in this project.
"""

from __future__ import annotations

import re
from urllib.parse import quote

from business_scout_worker.property.models import CapturedListing

DEFAULT_MESSAGE_TEMPLATE = (
    "Hi, I'm interested in your property listing: {title}"
    " ({community}, AED {price:,.0f}). Is it still available, and is the price negotiable? {url}"
)


def _digits_only(phone: str) -> str:
    """wa.me expects a bare country-code-prefixed number, no `+`/spaces/dashes."""
    return re.sub(r"\D", "", phone)


def build_whatsapp_link(
    phone_number: str, message_template: str | None, listing: CapturedListing
) -> str | None:
    """Returns a `https://wa.me/<digits>?text=<encoded message>` link, or None if `phone_number`
    doesn't contain enough digits to be a real number (defensive — the caller only calls this when
    a phone was actually revealed, but a malformed OCR/DOM read shouldn't produce a broken link)."""
    digits = _digits_only(phone_number)
    if len(digits) < 8:
        return None

    template = message_template or DEFAULT_MESSAGE_TEMPLATE
    dom = listing.dom
    try:
        message = template.format(
            title=listing.title,
            price=dom.price or 0,
            community=dom.community or dom.location_text or "the area",
            url=listing.listing_url or "",
        )
    except (KeyError, ValueError):
        # A malformed custom template (unknown placeholder, bad format spec) must not break the
        # whole job — fall back to a plain, placeholder-free message instead of raising.
        message = (
            f"Hi, I'm interested in your property listing: {listing.title}. Is it still available?"
        )

    return f"https://wa.me/{digits}?text={quote(message)}"
