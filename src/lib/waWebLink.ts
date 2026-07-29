/** Authored by: Mohit Singh */
//
// Converts a backend-built wa.me click-to-chat link into the equivalent web.whatsapp.com/send URL.
// The fast manual-send flow opens web.whatsapp.com directly (stays in one browser tab the operator
// can Ctrl+Tab back to) rather than wa.me, which can bounce through an app-picker interstitial.
//
// `URLSearchParams.get()` already percent-decodes its value — a second decodeURIComponent() on top
// of that throws "URI malformed" on any message containing a lone `%` (e.g. "30% off"), which is
// exactly the double-decode bug fixed in backend/whatsapp-sender/src/campaignRunner.ts. Don't
// reintroduce it here: read the already-decoded text once, re-encode with encodeURIComponent to
// build the new URL, and never decode a value that's already plain text.
export function toWebWhatsAppUrl(waMeLink: string): string {
  const source = new URL(waMeLink);
  const phone = source.pathname.replace(/^\//, "");
  const text = source.searchParams.get("text") ?? "";
  return `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;
}
