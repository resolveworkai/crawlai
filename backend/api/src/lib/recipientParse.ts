/** Authored by: Mohit Singh */
//
// Turns a source (uploaded CSV/XLSX, or selected finished OCR jobs) into a deduped list of UNIQUE
// businesses to message — each carrying business name / type / location / phone / email. Shared by
// the /marketing/recipients/preview endpoint and campaign creation. Pure data-shaping + one DB
// read for the OCR-job path; no side effects. xlsx via exceljs (already a dep); CSV via a small
// RFC-4180-ish parser (quoted fields, embedded commas/newlines, doubled quotes).
import ExcelJS from "exceljs";
import { pool } from "../db/pool.js";

export interface Recipient {
  businessName: string;
  businessType: string | null;
  location: string | null;
  phone: string | null; // normalized toward E.164 (leading +), or null
  email: string | null; // lowercased, or null
}

// --- phone / email normalization ---

/** Strip formatting to an E.164-ish string. Numbers from Google Maps arrive mostly as `+CC…`
 * already (the OCR DOM phone is `phone:tel:+…`); `00CC…` is coerced to `+CC…`. A bare 10-digit
 * number starting 6-9 is a local-format Indian mobile number (the crawler's target market — see
 * Haldwani/Nainital OCR jobs) and is coerced to `+91…`, mirroring the Python worker's
 * `parse/phone.py` (`phonenumbers.parse(num, region)` — "omitting it silently drops valid
 * national-format numbers"). Without this, the same business's number formatted with vs. without
 * a country code produces two different dedup keys and survives as a duplicate recipient. Any
 * other local number with no discernible country code is kept digit-only (best-effort — wa.me may
 * not resolve it, but we never silently drop a contact). Returns null if there aren't enough
 * digits to be a real number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    return digits.length >= 7 ? `+${digits}` : null;
  }
  if (digits.length < 7) return null;
  if (!hadPlus && /^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  return hadPlus ? `+${digits}` : digits;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  // Cheap sanity check — not full RFC validation, just "looks like an address".
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// --- column mapping for uploaded files ---

// Map a spreadsheet header (case/space-insensitive) to a recipient field. Accepts the OCR export's
// own headers ("Name", "Phone", "Email", "Category", "Address") plus common variants, so a file
// the operator tweaked in Excel still maps.
const HEADER_ALIASES: Record<keyof Recipient, string[]> = {
  businessName: ["business name", "name", "business", "company"],
  businessType: ["business type", "type", "category"],
  location: ["location", "city", "area", "address"],
  phone: ["phone", "mobile", "whatsapp", "number", "contact"],
  email: ["email", "e-mail", "mail"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildColumnIndex(headers: string[]): Partial<Record<keyof Recipient, number>> {
  const normalized = headers.map(normalizeHeader);
  const index: Partial<Record<keyof Recipient, number>> = {};
  for (const field of Object.keys(HEADER_ALIASES) as (keyof Recipient)[]) {
    for (const alias of HEADER_ALIASES[field]) {
      const at = normalized.indexOf(alias);
      if (at !== -1) {
        index[field] = at;
        break;
      }
    }
  }
  return index;
}

function rowToRecipient(
  row: (string | null)[],
  colIndex: Partial<Record<keyof Recipient, number>>,
): Recipient | null {
  const cell = (field: keyof Recipient): string | null => {
    const at = colIndex[field];
    if (at === undefined) return null;
    const v = row[at];
    return v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim();
  };
  const businessName = cell("businessName");
  if (!businessName) return null; // a row with no business name isn't a usable recipient
  return {
    businessName,
    businessType: cell("businessType"),
    location: cell("location"),
    phone: normalizePhone(cell("phone")),
    email: normalizeEmail(cell("email")),
  };
}

// --- CSV parsing (small RFC-4180-ish reader) ---

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a leading UTF-8 BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cellValue) => cellValue.trim() !== ""));
}

// --- public: parse an uploaded file (base64) into recipients ---

export async function parseUploadedRecipients(
  base64: string,
  filename: string,
): Promise<Recipient[]> {
  const buffer = Buffer.from(base64, "base64");
  const isXlsx = /\.xlsx$/i.test(filename);
  let table: string[][];

  if (isXlsx) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    table = [];
    sheet.eachRow((r) => {
      // exceljs row.values is 1-indexed with a leading undefined; map cells to plain strings.
      const values = (r.values as unknown[]).slice(1);
      table.push(
        values.map((v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "object" && "text" in (v as Record<string, unknown>)) {
            return String((v as { text: unknown }).text);
          }
          return String(v);
        }),
      );
    });
  } else {
    table = parseCsv(buffer.toString("utf-8"));
  }

  if (table.length < 2) return []; // header + at least one data row
  const [headerRow, ...dataRows] = table as [string[], ...string[][]];
  const colIndex = buildColumnIndex(headerRow);
  const out: Recipient[] = [];
  for (const row of dataRows) {
    const recipient = rowToRecipient(row, colIndex);
    if (recipient) out.push(recipient);
  }
  return out;
}

// --- public: build recipients from finished OCR jobs (data already in the DB) ---

// business_type = the OCR job's search query, location = the job's search location (that's the
// operator's own framing of "business type + location" from the plan). Each captured business
// also carries its own phone/email/name.
export async function buildRecipientsFromOcrJobs(jobIds: string[]): Promise<Recipient[]> {
  if (jobIds.length === 0) return [];
  const { rows } = await pool.query<{
    name: string;
    query: string;
    location: string;
    phone: string | null;
    email: string | null;
  }>(
    `SELECT b.name, j.query, j.location, b.phone, b.email
       FROM ocr_businesses b
       JOIN ocr_jobs j ON j.id = b.job_id
      WHERE b.job_id = ANY($1::uuid[])
      ORDER BY b.idx ASC`,
    [jobIds],
  );
  return rows.map((r) => ({
    businessName: r.name,
    businessType: r.query,
    location: r.location,
    phone: normalizePhone(r.phone),
    email: normalizeEmail(r.email),
  }));
}

// --- public: dedupe to UNIQUE businesses ---

// Keeps the first occurrence. Identity key: normalized phone, else lowercased email, else
// name+location — so the same business surfacing across overlapping OCR jobs / an uploaded file is
// collapsed to one recipient. Preserves business_type/location from the first row seen.
export function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of recipients) {
    const key = r.phone
      ? `p:${r.phone}`
      : r.email
        ? `e:${r.email}`
        : `n:${r.businessName.toLowerCase()}|${(r.location ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
