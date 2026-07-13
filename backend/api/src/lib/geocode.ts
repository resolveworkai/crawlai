/** Authored by: Mohit Singh */
//
// Geocoding lives entirely in Node (job-creation + the UI's location box) so the Python
// worker always receives coordinates and never geocodes itself — see
// .claude/skills/skills_backend_node.md.
import { ValidationError } from "../errors.js";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
// Nominatim's usage policy requires a descriptive User-Agent identifying the application.
const USER_AGENT = "business-scout-ai/0.1 (contact: admin@business-scout.local)";

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

export async function geocode(query: string): Promise<GeocodeResult> {
  const url = new URL("/search", NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Nominatim request failed: ${res.status}`);
  }
  const results = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const first = results[0];
  if (!first) {
    throw new ValidationError(`No location found for "${query}"`);
  }
  return { lat: Number(first.lat), lng: Number(first.lon), displayName: first.display_name };
}
