"""Authored by: Mohit Singh

Unit tests for property/whatsapp.py — the wa.me deep-link builder. No I/O, no network — this only
ever builds a URL string, never sends anything itself.
"""

from __future__ import annotations

from urllib.parse import unquote

from business_scout_worker.property.models import CapturedListing, DomListingFields
from business_scout_worker.property.whatsapp import build_whatsapp_link


def _listing(**dom_kwargs: object) -> CapturedListing:
    dom = DomListingFields.model_validate(dom_kwargs) if dom_kwargs else DomListingFields()
    return CapturedListing(
        idx=1,
        title="2BR Apartment in JVC",
        listing_url="https://dubai.dubizzle.com/property-for-sale/x-547320/",
        dom=dom,
    )


# --- phone digit handling ------------------------------------------------------------------------


def test_build_whatsapp_link_strips_plus_and_spaces() -> None:
    link = build_whatsapp_link("+971 52 204 3855", None, _listing())
    assert link is not None
    assert link.startswith("https://wa.me/971522043855?text=")


def test_build_whatsapp_link_strips_dashes() -> None:
    link = build_whatsapp_link("+971-52-204-3855", None, _listing())
    assert link is not None
    assert "971522043855" in link


def test_build_whatsapp_link_none_when_fewer_than_8_digits() -> None:
    assert build_whatsapp_link("12345", None, _listing()) is None


def test_build_whatsapp_link_none_for_empty_phone() -> None:
    assert build_whatsapp_link("", None, _listing()) is None


def test_build_whatsapp_link_none_for_non_digit_garbage() -> None:
    assert build_whatsapp_link("N/A", None, _listing()) is None


# --- message templating -----------------------------------------------------------------------


def test_build_whatsapp_link_default_template_includes_price_and_community() -> None:
    listing = _listing(price=850_000, community="JVC")
    link = build_whatsapp_link("+971522043855", None, listing)
    assert link is not None
    message = unquote(link.split("?text=", 1)[1])
    assert "850,000" in message
    assert "JVC" in message
    assert listing.title in message


def test_build_whatsapp_link_custom_template_placeholders_substituted() -> None:
    listing = _listing(price=1_200_000, community="Downtown")
    template = "Hi, interested in {title} for AED {price:,.0f} in {community}. Link: {url}"
    link = build_whatsapp_link("+971522043855", template, listing)
    assert link is not None
    message = unquote(link.split("?text=", 1)[1])
    assert "2BR Apartment in JVC" in message
    assert "1,200,000" in message
    assert "Downtown" in message
    assert listing.listing_url is not None
    assert listing.listing_url in message


def test_build_whatsapp_link_falls_back_to_location_text_when_no_community() -> None:
    listing = _listing(price=500_000, location_text="Al Barsha South")
    link = build_whatsapp_link("+971522043855", None, listing)
    assert link is not None
    message = unquote(link.split("?text=", 1)[1])
    assert "Al Barsha South" in message


def test_build_whatsapp_link_neutral_fallback_when_no_community_or_location() -> None:
    listing = _listing(price=500_000)
    link = build_whatsapp_link("+971522043855", None, listing)
    assert link is not None
    message = unquote(link.split("?text=", 1)[1])
    assert "the area" in message


def test_build_whatsapp_link_malformed_template_falls_back_gracefully() -> None:
    # An unknown placeholder must not raise — falls back to a plain message instead.
    listing = _listing(price=500_000)
    link = build_whatsapp_link("+971522043855", "Hi {nonexistent_field}", listing)
    assert link is not None
    message = unquote(link.split("?text=", 1)[1])
    assert listing.title in message
    assert "still available" in message


def test_build_whatsapp_link_price_defaults_to_zero_when_dom_has_none() -> None:
    listing = _listing()  # no price at all
    link = build_whatsapp_link("+971522043855", None, listing)
    assert link is not None  # must not crash on a missing price


def test_build_whatsapp_link_message_is_url_encoded() -> None:
    listing = _listing(price=500_000, community="JVC")
    link = build_whatsapp_link("+971522043855", None, listing)
    assert link is not None
    assert " " not in link.split("?text=", 1)[1]  # spaces must be percent/plus encoded
