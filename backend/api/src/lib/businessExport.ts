/** Authored by: Mohit Singh */
//
// Shared column mapping for every export format (xlsx/csv/json) — one place defines what a
// business "export row" looks like, per md/plans/0001-*.md's "Fill only the columns backing the
// 10 requirements" rule (not all ~60 technical/AI columns). `google_map_url` has no DB writer
// anywhere in the pipeline (req #7 says "constructed from coordinates"), so it's derived here at
// export time rather than persisted.
import type { Business } from "../types/db.js";

export function googleMapsUrl(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null) return null;
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

// Column order for CSV/XLSX — the flat, spreadsheet-friendly view. Keep header labels stable;
// re-downloading an older export and a fresh one should look the same shape.
export const FLAT_EXPORT_HEADERS = [
  "Name",
  "Sub Name",
  "Category",
  "Address Line 1",
  "Address Line 2",
  "Area",
  "City",
  "State",
  "Country",
  "Postal Code",
  "Latitude",
  "Longitude",
  "Google Maps Link",
  "Email",
  "All Emails",
  "Phone",
  "All Phones",
  "Website",
  "About",
  "Google Rating",
  "Review Count",
  "Review URL",
  "Opening Hours",
  "Enrichment Status",
  "Extras",
  "Created At",
  "Updated At",
] as const;

export type FlatExportRow = Record<(typeof FLAT_EXPORT_HEADERS)[number], string | number | null>;

export function toFlatRow(b: Business): FlatExportRow {
  return {
    Name: b.name,
    "Sub Name": b.sub_name,
    Category: b.category,
    "Address Line 1": b.address_line1,
    "Address Line 2": b.address_line2,
    Area: b.area,
    City: b.city,
    State: b.state,
    Country: b.country,
    "Postal Code": b.postal_code,
    Latitude: b.latitude,
    Longitude: b.longitude,
    "Google Maps Link": googleMapsUrl(b.latitude, b.longitude),
    Email: b.email,
    "All Emails": b.emails && b.emails.length > 0 ? b.emails.join("; ") : null,
    Phone: b.phone,
    "All Phones": b.phones && b.phones.length > 0 ? b.phones.join("; ") : null,
    Website: b.website_url,
    About: b.about_text,
    "Google Rating": b.google_rating,
    "Review Count": b.review_count,
    "Review URL": b.review_url,
    "Opening Hours": b.opening_hours ? JSON.stringify(b.opening_hours) : null,
    "Enrichment Status": b.enrichment_status,
    Extras: b.extras && Object.keys(b.extras).length > 0 ? JSON.stringify(b.extras) : null,
    "Created At": b.created_at.toISOString(),
    "Updated At": b.updated_at.toISOString(),
  };
}

// The JSON export gets the design's explicitly-requested "structured, nested" shape (arrays as
// arrays, extras/openingHours as real objects) rather than the CSV/XLSX flattened strings.
export function toNestedJson(b: Business): Record<string, unknown> {
  return {
    id: b.id,
    name: b.name,
    subName: b.sub_name,
    category: b.category,
    address: {
      line1: b.address_line1,
      line2: b.address_line2,
      area: b.area,
      city: b.city,
      state: b.state,
      country: b.country,
      postalCode: b.postal_code,
    },
    location: {
      latitude: b.latitude,
      longitude: b.longitude,
      googleMapsUrl: googleMapsUrl(b.latitude, b.longitude),
    },
    contact: {
      email: b.email,
      emails: b.emails ?? [],
      phone: b.phone,
      phones: b.phones ?? [],
      whatsapp: b.whatsapp,
      website: b.website_url,
    },
    about: b.about_text,
    google: {
      rating: b.google_rating,
      reviewCount: b.review_count,
      reviewUrl: b.review_url,
    },
    openingHours: b.opening_hours,
    enrichmentStatus: b.enrichment_status,
    extras: b.extras,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}
