/** Authored by: Mohit Singh */
//
// Phase 8 security pass — rate limiting on the two genuinely brute-forceable/abusable surfaces:
// login (credential stuffing / password guessing) and the public /api/v1 (a leaked or shared
// key shouldn't be able to hammer the DB unbounded). Everything else sits behind the cookie-
// based session (requireAuth) already, so an attacker needs valid credentials first — the
// blast radius without rate limiting is much smaller there. See
// .claude/skills/skills_security.md and md/plans/0001-*.md "Phase 8".
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many login attempts, try again later" } },
});

// Keyed by API key when present (not just IP) — several consumers can legitimately share an
// egress IP (NAT, corporate proxy), and a leaked/misbehaving key should be throttled on its own
// identity rather than penalizing every other key behind the same IP.
export const publicApiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    const headerKeyRaw = req.headers["x-api-key"];
    const headerKey = (Array.isArray(headerKeyRaw) ? headerKeyRaw[0] : headerKeyRaw)?.trim();
    // No-key fallback goes through ipKeyGenerator (not raw req.ip) — it buckets IPv6 addresses
    // by /56 subnet, so an IPv6 user can't dodge the limit by rotating through the trillions of
    // addresses in their own prefix. Raw req.ip here is a real bypass (flagged by
    // express-rate-limit's own startup validation, ERR_ERL_KEY_GEN_IPV6).
    return bearerKey || headerKey || (req.ip ? ipKeyGenerator(req.ip) : "unknown");
  },
  message: { error: { code: "RATE_LIMITED", message: "Too many requests, slow down" } },
});
