"""Authored by: Mohit Singh"""

from __future__ import annotations

from pydantic import BaseModel


class Tier1Result(BaseModel):
    """Everything Tier-1 (plain HTTP fetch + parse, no browser) could extract from a
    business's website. All fields best-effort — a business with no working site, or a site
    Tier-1 can't parse, still gets a valid (mostly-empty) result; see req #4's "best-effort per
    site" note in md/plans/0001-*.md's coverage matrix."""

    website_title: str | None = None
    meta_description: str | None = None
    meta_keywords: str | None = None
    about_text: str | None = None
    contact_url: str | None = None

    emails: list[str] = []
    phones: list[str] = []

    facebook: str | None = None
    instagram: str | None = None
    linkedin: str | None = None
    youtube: str | None = None
    twitter: str | None = None
    whatsapp: str | None = None

    logo_url: str | None = None
    hero_image_url: str | None = None
    image_urls: list[str] = []
    """Additional business photos beyond logo/hero — req #9 (>=3 photos)."""
