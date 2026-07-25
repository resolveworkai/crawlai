"""Authored by: Mohit Singh

All Google Maps DOM selectors in ONE place (§7 risk mitigation) — Maps randomizes its CSS
class names (`hfpxzc`, `DUwDvf`, …) and reships its DOM without notice, so every selector here
has a role/aria fallback and the whole file is the first thing to check when capture breaks
(`npm run` smoke / the module README). Prefer role/aria over class names wherever possible.
"""

from __future__ import annotations

# The scrollable results list. role="feed" is stable; the class is the fragile part.
RESULTS_FEED = 'div[role="feed"]'

# Result cards: primary is the class-based anchor Maps uses today; fallback is the stable
# href-shape match (every place link contains /maps/place/).
RESULT_ANCHOR_PRIMARY = 'div[role="feed"] a.hfpxzc'
RESULT_ANCHOR_FALLBACK = 'div[role="feed"] a[href*="/maps/place/"]'

# The detail panel. The feed is ALSO a role="main"; the place panel is a SECOND role="main"
# whose aria-label equals the business name — so callers take the LAST match. The h1 inside it
# is the business title (class DUwDvf drifts — match on the role="main" h1 instead).
DETAIL_PANEL = 'div[role="main"]'
DETAIL_TITLE = "h1"

# Consent screen (first-visit / fresh-profile). One click, remembered by the persistent profile.
CONSENT_ACCEPT = 'button:has-text("Accept all"), form[action*="consent"] button'

# Block / CAPTCHA signals (§A3) — presence of any means stop cleanly, never solve.
RECAPTCHA_IFRAME = 'iframe[src*="recaptcha"]'

# End-of-feed sentinel text (§A7 stop condition).
END_OF_LIST_TEXT = "You've reached the end of the list."

# --- Structured DOM fields (authoritative, no OCR) -------------------------------------------
# Google Maps exposes the contact fields as `data-item-id` buttons/links with human aria-labels —
# these are MUCH more stable than CSS classes (Maps uses them for its own analytics/accessibility)
# and give exact values, which is why phone/website/address/plus-code are read from the DOM here
# rather than OCR'd from the screenshot (OCR misreads digits — the whole point of this crawl is
# accurate phone numbers). OCR remains the fallback + the visual audit trail.
#   phone button:  data-item-id="phone:tel:+919...", aria-label="Phone: +91 9..."
#   website link:  data-item-id="authority",         href is the real URL
#   address btn:   data-item-id="address",           aria-label="Address: ..."
#   plus code btn: data-item-id="oloc",              aria-label="Plus code: 6G64+J7 ..."
DOM_PHONE = 'button[data-item-id^="phone:tel:"]'
DOM_WEBSITE = 'a[data-item-id="authority"]'
DOM_ADDRESS = 'button[data-item-id="address"]'
DOM_PLUS_CODE = 'button[data-item-id^="oloc"]'
