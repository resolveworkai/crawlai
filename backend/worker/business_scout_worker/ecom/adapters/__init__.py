"""Authored by: Mohit Singh

Platform-adapter registry for the e-commerce Product Research pipeline. Each supported
marketplace (noon, amazon; aliexpress reserved) implements `PlatformAdapter` (base.py) and is
registered here by its `ecom_jobs.platform` string. `get_adapter` is the single place the
pipeline/capture engine goes to resolve "which site am I scraping" — never import a concrete
adapter class directly outside this module and its own file.
"""

from __future__ import annotations

from business_scout_worker.ecom.adapters.aliexpress import AliExpressAdapter
from business_scout_worker.ecom.adapters.amazon import AmazonAdapter
from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.adapters.noon import NoonAdapter

_REGISTRY: dict[str, type[PlatformAdapter]] = {
    "noon": NoonAdapter,
    "amazon": AmazonAdapter,
    "aliexpress": AliExpressAdapter,
}


def get_adapter(platform: str) -> PlatformAdapter:
    """Instantiates the adapter for `platform`. Raises ValueError for a platform string that
    isn't registered at all (a genuine typo/unknown site — the DB CHECK constraint on
    ecom_jobs.platform should already prevent this in practice). A registered-but-unimplemented
    platform (aliexpress today) raises NotImplementedError lazily from its own methods, not here
    — the adapter object itself is valid to construct, it just can't search/extract yet."""
    adapter_cls = _REGISTRY.get(platform)
    if adapter_cls is None:
        raise ValueError(f"Unknown e-commerce platform: {platform!r}")
    return adapter_cls()


def cdp_required_platforms() -> frozenset[str]:
    """Platforms whose adapter sets REQUIRES_CDP — they CANNOT run in the headless container
    daemon and are handled only by the host runner (run_noon_host.py) attached to the operator's
    real Chrome. The containerized daemon excludes these from its claim; the host runner claims
    only these. Single source of truth so the two claim filters never drift."""
    return frozenset(name for name, cls in _REGISTRY.items() if cls.REQUIRES_CDP)


__all__ = ["PlatformAdapter", "cdp_required_platforms", "get_adapter"]
