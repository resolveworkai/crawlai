"""Authored by: Mohit Singh

AliExpress adapter — registered (so `get_adapter("aliexpress")` and the DB CHECK constraint on
ecom_jobs.platform both already accept it) but not yet implemented. AliExpress's search results
are far more aggressively bot-gated (heavy client-side rendering + frequent CAPTCHA) than
noon/amazon, so this is reserved for a later pass rather than shipped half-working. Every method
raises NotImplementedError so a job accidentally queued for this platform fails loudly and
immediately in the pipeline rather than silently producing empty/garbage results.
"""

from __future__ import annotations

from typing import ClassVar

from playwright.async_api import ElementHandle, Page

from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.models import DomProductFields, SortMode

_NOT_IMPLEMENTED = "AliExpress adapter not yet implemented"


class AliExpressAdapter(PlatformAdapter):
    platform: ClassVar[str] = "aliexpress"
    default_currency: ClassVar[str] = "AED"
    uses_pagination: ClassVar[bool] = True
    CARD_SELECTOR: ClassVar[str] = ""
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = ()

    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def prepare_page(self, page: Page) -> None:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def is_blocked(self, page: Page) -> bool:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def product_key(self, href: str | None) -> str | None:
        raise NotImplementedError(_NOT_IMPLEMENTED)
