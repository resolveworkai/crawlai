/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";
import { RequireAuth } from "@/components/require-auth";
import { useBusinesses, useDeleteBusiness } from "@/hooks/useBusinesses";
import { timeAgo } from "@/lib/utils";
import { Search, ExternalLink, Mail, Phone, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { EnrichmentStatus } from "@/types/api";

export const Route = createFileRoute("/businesses")({
  component: () => (
    <RequireAuth>
      <Businesses />
    </RequireAuth>
  ),
});

const PAGE_SIZE = 20;
const STATUS_FILTERS: { label: string; value: EnrichmentStatus | undefined }[] = [
  { label: "All", value: undefined },
  { label: "Enriched", value: "enriched" },
  { label: "Crawling", value: "crawling" },
  { label: "Queued", value: "queued" },
  { label: "Failed", value: "failed" },
];

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
}

function Businesses() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<EnrichmentStatus | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const deleteBusiness = useDeleteBusiness();

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      enrichmentStatus: status,
      limit: PAGE_SIZE,
      offset,
    }),
    [search, status, offset],
  );
  const { data, isLoading } = useBusinesses(filters);
  const businesses = data?.businesses ?? [];
  const total = data?.total ?? 0;

  return (
    <AppShell
      title="Businesses"
      subtitle={`Your deduplicated master database — ${total.toLocaleString()} records.`}
    >
      <Card className="border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Search by name…"
              className="pl-8 bg-input border-border h-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.label}
                onClick={() => {
                  setStatus(f.value);
                  setOffset(0);
                }}
                className={`rounded-md px-2.5 py-1 transition-colors ${status === f.value ? "bg-primary/15 text-primary" : "hover:bg-accent hover:text-foreground"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Business</th>
                <th className="px-2 py-2.5 text-left font-medium">Category</th>
                <th className="px-2 py-2.5 text-left font-medium">Contact</th>
                <th className="px-2 py-2.5 text-left font-medium">Location</th>
                <th className="px-2 py-2.5 text-left font-medium">Rating</th>
                <th className="px-2 py-2.5 text-left font-medium">Status</th>
                <th className="px-2 py-2.5 text-right font-medium">Updated</th>
                <th className="w-10 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && businesses.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No businesses yet — launch a crawl from Discover to populate the master DB.
                  </td>
                </tr>
              )}
              {businesses.map((b) => (
                <tr key={b.id} className="group transition-colors hover:bg-accent/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-chart-3/20 text-[11px] font-semibold text-primary ring-1 ring-border">
                        {initials(b.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium">{b.name}</div>
                        {b.website_url ? (
                          <a
                            className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-primary"
                            href={b.website_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {b.website_url.replace(/^https?:\/\//, "")}{" "}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        ) : (
                          <span className="font-mono text-[10px] text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
                      {b.category ?? "—"}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" /> {b.email ?? "—"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {b.phone ?? "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-3 text-xs">{b.city ?? "—"}</td>
                  <td className="px-2 py-3">
                    {b.google_rating ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Star className="h-3 w-3 fill-warning text-warning" /> {b.google_rating}{" "}
                        {b.review_count !== null && (
                          <span className="text-muted-foreground">({b.review_count})</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-3">
                    <StatusBadge status={b.enrichment_status} />
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-[10px] text-muted-foreground">
                    {timeAgo(b.updated_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete "${b.name}"? This cannot be undone.`)) {
                          deleteBusiness.mutate(b.id, {
                            onError: (err) => toast.error(err.message),
                          });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            Showing{" "}
            <span className="text-foreground">
              {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
            </span>{" "}
            of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-border text-xs"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </AppShell>
  );
}
