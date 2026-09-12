/** Authored by: Mohit Singh */
//
// The AppShell header has always shown a "Search businesses, jobs, fields…" box with a ⌘K hint —
// it was pure static markup (a <span>, no <input>, no click handler, no shortcut listener) with
// zero functionality wired up. This is the real implementation: click the box or press Ctrl/Cmd+K
// anywhere in the app to open it, type to search across the three domains the placeholder always
// promised (businesses/jobs/dynamic fields), click a result to jump to its page.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search, X, Building2, ListChecks, ListTree, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { businessKeys } from "@/hooks/useBusinesses";
import { useJobs } from "@/hooks/useJobs";
import { useDynamicFields } from "@/hooks/useDynamicFields";
import type { Business } from "@/types/api";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function GlobalSearchTrigger({ onOpen }: { onOpen: () => void }) {
  // Global Ctrl/Cmd+K listener, matching the kbd hint this box has always shown — lives here
  // (mounted once by AppShell, not per-page) so the shortcut works from any route.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);

  return (
    <button
      onClick={onOpen}
      className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm text-muted-foreground w-80 hover:border-primary/40 hover:text-foreground"
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Search businesses, jobs, fields…</span>
      <kbd className="ml-auto flex shrink-0 items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
        <span>Ctrl</span> K
      </kbd>
    </button>
  );
}

// z-[60] (not the header's z-30, not the standard shadcn library's z-50) — same reasoning as
// GlobalSearchModal/CompareModal in property-crawl.tsx: this must always sit above every other
// overlay in the app, including a still-mounted Popover/Select left open on the page underneath.
export function GlobalCommandSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const trimmed = debounced.trim();
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Businesses: real backend search (the list can be large) — the query itself is `enabled` only
  // once >= 2 chars, rather than always firing a request every time the palette opens.
  const businessQueryEnabled = trimmed.length >= 2;
  const { data: businesses = [], isFetching: businessesLoading } = useQuery({
    queryKey: businessKeys.list({ search: trimmed, limit: 6 }),
    queryFn: async () =>
      (
        await api.get<{ businesses: Business[] }>(
          `/businesses?search=${encodeURIComponent(trimmed)}&limit=6`,
        )
      ).businesses,
    enabled: businessQueryEnabled,
  });

  // Jobs/Fields: both lists are small (own dedicated pages with no pagination), so a plain
  // client-side filter of the already-fetched list is simpler and cheaper than adding server-side
  // search support to either endpoint just for this palette.
  const { data: allJobs = [] } = useJobs();
  const { data: allFields = [] } = useDynamicFields();

  const jobs = useMemo(() => {
    if (trimmed.length < 2) return [];
    const q = trimmed.toLowerCase();
    return allJobs
      .filter(
        (j) =>
          j.business_type.toLowerCase().includes(q) ||
          (j.location_label?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 6);
  }, [allJobs, trimmed]);

  const fields = useMemo(() => {
    if (trimmed.length < 2) return [];
    const q = trimmed.toLowerCase();
    return allFields
      .filter(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.key.toLowerCase().includes(q) ||
          f.prompt.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [allFields, trimmed]);

  const hasAnyResults = businesses.length > 0 || jobs.length > 0 || fields.length > 0;

  function go(to: "/businesses" | "/jobs" | "/fields") {
    void navigate({ to });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[8vh]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[70vh] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card"
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search businesses, jobs, fields…"
            className="h-9 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          {businessesLoading && trimmed.length >= 2 && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <button
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(70vh-56px)] overflow-y-auto p-2">
          {trimmed.length > 0 && trimmed.length < 2 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Keep typing — at least 2 characters.
            </p>
          )}
          {trimmed.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Type to search across businesses, crawl jobs, and dynamic fields.
            </p>
          )}
          {trimmed.length >= 2 && !hasAnyResults && !businessesLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No matches for "{trimmed}".
            </p>
          )}

          {businesses.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                Businesses
              </div>
              {businesses.map((b) => (
                <button
                  key={b.id}
                  onClick={() => go("/businesses")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{b.name}</span>
                  {b.city && (
                    <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                      {b.city}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {jobs.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                Jobs
              </div>
              {jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => go("/jobs")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{j.business_type}</span>
                  {j.location_label && (
                    <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                      {j.location_label}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {fields.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                Fields
              </div>
              {fields.map((f) => (
                <button
                  key={f.id}
                  onClick={() => go("/fields")}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ListTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{f.label}</span>
                  <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                    {f.key}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
