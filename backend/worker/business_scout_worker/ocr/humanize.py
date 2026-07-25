"""Authored by: Mohit Singh

Human-like input helpers (§A5) — the capture engine's requirement to "use the mouse to
traverse". Real cursor movement (multi-waypoint glide + jitter + hover) and randomized dwell
times keep the automation's behavioral fingerprint closer to a person's; combined with the
persistent profile, single-job lock, and result caps, this keeps CAPTCHA walls rare. None of it
makes the automation undetectable — see the module README's compliance note.
"""

from __future__ import annotations

import asyncio
import random

from playwright.async_api import ElementHandle, Page


async def dwell(min_ms: int, max_ms: int) -> None:
    await asyncio.sleep(random.uniform(min_ms, max_ms) / 1000)


async def move_and_click(page: Page, element: ElementHandle) -> None:
    """Glide the cursor to `element` over 2-3 jittered waypoints, hover briefly, then click —
    instead of an instant programmatic click (a strong bot tell). Falls back to element.click()
    if the bounding box can't be resolved (element scrolled out, etc.)."""
    box = await element.bounding_box()
    if box is None:
        await element.click()
        return

    target_x = box["x"] + box["width"] / 2
    target_y = box["y"] + box["height"] / 2

    # 2-3 intermediate points wandering toward the target with a little jitter.
    steps = random.randint(2, 3)
    start_x = target_x - random.uniform(60, 160)
    start_y = target_y - random.uniform(40, 120)
    for i in range(1, steps + 1):
        frac = i / steps
        x = start_x + (target_x - start_x) * frac + random.uniform(-6, 6)
        y = start_y + (target_y - start_y) * frac + random.uniform(-6, 6)
        await page.mouse.move(x, y)
        await asyncio.sleep(random.uniform(0.03, 0.08))

    await page.mouse.move(target_x, target_y)
    await asyncio.sleep(random.uniform(0.12, 0.20))  # hover
    await page.mouse.click(target_x, target_y)


async def wheel_over(page: Page, x: float, y: float, delta_y: float) -> None:
    """Mouse-wheel scroll at a point — works regardless of which nested div is the actual scroll
    container (no fragile scrollTop targeting), matching real user input."""
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, delta_y)
