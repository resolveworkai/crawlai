/** Authored by: Mohit Singh */
//
// Parses a pasted "building name / completion year / age label" table (the exact shape the user
// provides per region, e.g. copy-pasted from a spreadsheet) into structured entries for
// db/propertyBuildingAges.ts's bulkUpsertBuildingAges. Two parse strategies, tried per-line:
//   1. Tab-separated (the common case when pasted straight from Excel/Sheets/Docs — most reliable
//      when it applies, since it doesn't need to guess where the name ends and the year begins).
//   2. A regex anchored on the completion-year token itself (a distinctive `YYYY`/`YYYY*`/
//      `YYYY/YY*`/`N/V` pattern), for text that arrived with spaces instead of real tabs.
// Header/title lines (anything that doesn't contain a recognizable year-or-N/V token) are skipped
// silently rather than erroring the whole import over one bad line.
import type { BuildingAgeEntry } from "../db/propertyBuildingAges.js";

const NOT_AVAILABLE_RE = /^n\/?v$/i;
// Matches: "2025", "2027*", "2015/16", "2015/16*" — captures the FIRST (earliest) year, and
// whether the source marked it as estimated (a trailing "*", or a "/YY" range — a range is
// inherently an uncertain single year).
const YEAR_TOKEN_RE = /^(\d{4})(\/(\d{2}))?(\*)?$/;

function parseCompletionCell(cell: string): { year: number | null; estimated: boolean } {
  const trimmed = cell.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-" || NOT_AVAILABLE_RE.test(trimmed)) {
    return { year: null, estimated: false };
  }
  const m = YEAR_TOKEN_RE.exec(trimmed);
  if (!m) return { year: null, estimated: false };
  const year = Number(m[1]);
  const isRange = m[2] !== undefined;
  const isStarred = m[4] !== undefined;
  return { year, estimated: isRange || isStarred };
}

// A line "looks like a data row" if the completion-year column contains a real year token or
// N/V — used to reject header/title lines without needing an exact column-count match.
const LOOKS_LIKE_YEAR_OR_NA = /(\d{4}(\/\d{2})?\*?|N\/?V)/i;

function parseTabSeparatedLine(line: string): BuildingAgeEntry | null {
  const cells = line.split("\t").map((c) => c.trim());
  if (cells.length < 3) return null;
  // Optional leading "#" row-number column — drop it if the first cell is purely numeric.
  const withoutIndex = /^\d+\.?$/.test(cells[0] ?? "") ? cells.slice(1) : cells;
  const [name, completionCell] = withoutIndex;
  if (!name || !completionCell || !LOOKS_LIKE_YEAR_OR_NA.test(completionCell)) return null;
  const { year, estimated } = parseCompletionCell(completionCell);
  return { buildingName: name, completionYear: year, isEstimated: estimated };
}

// Fallback for space-aligned (not real-tab) text — anchors on the year/N-V token itself so it
// doesn't need to guess a fixed column width. Captures: optional leading row number, the building
// name (everything up to the year token), the year token, and discards the rest of the line (the
// human-readable "age in <year>" label — always re-derived at read time instead of stored, see
// propertyBuildingAges.ts).
const REGEX_ROW_RE = /^\s*(?:\d+\.?\s+)?(.+?)\s+(\d{4}(?:\/\d{2})?\*?|N\/?V)\s+\S.*$/i;

function parseRegexLine(line: string): BuildingAgeEntry | null {
  const m = REGEX_ROW_RE.exec(line);
  if (!m) return null;
  const name = m[1]?.trim();
  const completionCell = m[2];
  if (!name || !completionCell) return null;
  const { year, estimated } = parseCompletionCell(completionCell);
  return { buildingName: name, completionYear: year, isEstimated: estimated };
}

export function parseBuildingAgeTable(rawText: string): BuildingAgeEntry[] {
  const entries: BuildingAgeEntry[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const entry = parseTabSeparatedLine(line) ?? parseRegexLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}
