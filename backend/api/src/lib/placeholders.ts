/** Authored by: Mohit Singh */
//
// Substitutes {business_name} / {business_type} / {location} / {city} placeholders in a template
// body or subject with a recipient's real values. Shared by the email send loop, the wa.me link
// builder, and the live preview so they can never drift. Unknown placeholders are left as-is
// (safer than blanking them — the operator sees the literal token and can fix the template).
import type { Recipient } from "./recipientParse.js";

export interface PlaceholderValues {
  business_name: string;
  business_type: string;
  location: string;
  city: string;
}

export function recipientToPlaceholders(r: Recipient): PlaceholderValues {
  const location = r.location ?? "";
  return {
    business_name: r.businessName,
    business_type: r.businessType ?? "",
    location,
    // {city} is a convenience alias: the first comma-separated part of the location
    // (e.g. "Al Nahda, Dubai" → "Al Nahda"), falling back to the whole location.
    city: location.split(",")[0]?.trim() ?? location,
  };
}

const TOKEN_RE = /\{(business_name|business_type|location|city)\}/g;

export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN_RE, (_match, key: keyof PlaceholderValues) => values[key]);
}

/** The placeholder tokens the UI offers as insert-buttons (kept in one place). */
export const SUPPORTED_PLACEHOLDERS = [
  "business_name",
  "business_type",
  "location",
  "city",
] as const;
