"""Authored by: Mohit Singh

Platform-adapter registry for the Property Research pipeline. Mirrors ecom/adapters/__init__.py's
shape exactly. `get_adapter` is the single place the pipeline/capture engine goes to resolve
"which site am I scraping" — never import a concrete adapter class directly outside this module
and its own file.
"""

from __future__ import annotations

from business_scout_worker.property.adapters.base import PlatformAdapter
from business_scout_worker.property.adapters.dubizzle import DubizzleAdapter
from business_scout_worker.property.adapters.propertyfinder import PropertyFinderAdapter

_REGISTRY: dict[str, type[PlatformAdapter]] = {
    "dubizzle": DubizzleAdapter,
    "propertyfinder": PropertyFinderAdapter,
}


def get_adapter(platform: str) -> PlatformAdapter:
    """Instantiates the adapter for `platform`. Raises ValueError for an unregistered platform
    string (the DB CHECK constraint on property_jobs.platform should already prevent this)."""
    adapter_cls = _REGISTRY.get(platform)
    if adapter_cls is None:
        raise ValueError(f"Unknown property platform: {platform!r}")
    return adapter_cls()


def cdp_required_platforms() -> frozenset[str]:
    """Every platform in this module requires CDP today (see PlatformAdapter.REQUIRES_CDP's
    docstring) — kept as a function (not a bare constant) for parity with
    ecom/adapters.cdp_required_platforms() and so a future headless-capable platform doesn't need
    a call-site change, just its own REQUIRES_CDP=False."""
    return frozenset(name for name, cls in _REGISTRY.items() if cls.REQUIRES_CDP)


__all__ = ["PlatformAdapter", "cdp_required_platforms", "get_adapter"]
