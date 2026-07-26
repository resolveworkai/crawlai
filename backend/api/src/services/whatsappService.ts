/** Authored by: Mohit Singh */
//
// WhatsApp = click-to-chat + vCard (no automation, no credentials, ToS-safe — see md/MARKETING.md).
// Per business we build a wa.me deep link that opens WhatsApp with the curated message pre-filled;
// the operator presses Send. A one-time vCard export saves every business into their phone contacts
// BY BUSINESS NAME, so chats are labelled correctly.
import type { Recipient } from "../lib/recipientParse.js";
import { recipientToPlaceholders, renderPlaceholders } from "../lib/placeholders.js";

/** Digits-only international number for a wa.me path (strip +, spaces, leading zeros). Returns null
 * when there's nothing dialable — that recipient can't get a WhatsApp link. */
export function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "").replace(/^0+/, "");
  return digits.length >= 7 ? digits : null;
}

/** `https://wa.me/<number>?text=<url-encoded rendered body>` — null if the recipient has no usable
 * phone. The body has placeholders substituted per recipient. */
export function buildWaLink(recipient: Recipient, body: string): string | null {
  const number = waNumber(recipient.phone);
  if (!number) return null;
  const text = renderPlaceholders(body, recipientToPlaceholders(recipient));
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

// --- vCard (.vcf) ---

// vCard 3.0 escaping: backslash, comma, semicolon, newline per RFC 6350/2426.
function vcardEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function singleVcard(recipient: Recipient): string | null {
  const number = waNumber(recipient.phone);
  if (!number) return null; // no phone → nothing to save as a WhatsApp contact
  const name = vcardEscape(recipient.businessName);
  const org = recipient.businessType ? vcardEscape(recipient.businessType) : "";
  const note = vcardEscape(
    [recipient.businessType, recipient.location].filter(Boolean).join(" · "),
  );
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `N:${name};;;;`,
    `TEL;TYPE=CELL:+${number}`,
  ];
  if (org) lines.push(`ORG:${org}`);
  if (note) lines.push(`NOTE:${note}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

/** Concatenated vCards (one per business with a usable phone) — a single importable .vcf file. */
export function buildVcard(recipients: Recipient[]): string {
  return (
    recipients
      .map(singleVcard)
      .filter((v): v is string => v !== null)
      .join("\r\n") + "\r\n"
  );
}
