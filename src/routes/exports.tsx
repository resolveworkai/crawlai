/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RequireAuth } from "@/components/require-auth";
import { FileSpreadsheet, FileJson, FileText, Download, Filter } from "lucide-react";

// Exports (generate xlsx/csv/json + persisted history + retention cleanup) is Phase 7 —
// no backend endpoint exists yet, so this screen intentionally stays a non-functional
// preview rather than being wired to real API. See md/plans/0001-*.md Phase 7.
export const Route = createFileRoute("/exports")({
  component: () => (
    <RequireAuth>
      <Exports />
    </RequireAuth>
  ),
});

const formats = [
  {
    name: "Excel",
    desc: "Multi-sheet .xlsx with images, contacts, dynamic fields.",
    icon: FileSpreadsheet,
    color: "text-success",
    bg: "bg-success/15 ring-success/30",
    ext: ".xlsx",
  },
  {
    name: "CSV",
    desc: "Flat comma-separated, one row per business.",
    icon: FileText,
    color: "text-primary",
    bg: "bg-primary/15 ring-primary/30",
    ext: ".csv",
  },
  {
    name: "JSON",
    desc: "Structured nested export including all extras.",
    icon: FileJson,
    color: "text-chart-3",
    bg: "bg-chart-3/15 ring-chart-3/30",
    ext: ".json",
  },
];

function Exports() {
  return (
    <AppShell
      title="Exports"
      subtitle="Ship your enriched data anywhere — Excel, CSV or JSON. Coming in Phase 7."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {formats.map((f) => (
          <Card
            key={f.name}
            className="group relative overflow-hidden border-border bg-card p-5 opacity-70"
          >
            <div className="relative">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-lg ring-1 ${f.bg}`}
              >
                <f.icon className={`h-5 w-5 ${f.color}`} />
              </div>
              <h3 className="mt-3 font-display text-lg font-semibold">{f.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{f.desc}</p>
              <div className="mt-4 flex items-center justify-between">
                <code className="font-mono text-[10px] text-muted-foreground">{f.ext}</code>
                <Button size="sm" disabled className="gap-1.5">
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-6 border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-5">
          <div>
            <h3 className="font-display text-base font-semibold">Recent exports</h3>
            <p className="text-xs text-muted-foreground">Not available yet — Phase 7.</p>
          </div>
          <Button variant="outline" size="sm" className="border-border gap-1.5" disabled>
            <Filter className="h-3.5 w-3.5" /> Filter
          </Button>
        </div>
        <div className="p-8 text-center text-sm text-muted-foreground">
          Export generation, history and re-download will ship in Phase 7.
        </div>
      </Card>
    </AppShell>
  );
}
