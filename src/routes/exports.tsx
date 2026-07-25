/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RequireAuth } from "@/components/require-auth";
import { useCreateExport, useExports, downloadExportUrl } from "@/hooks/useExports";
import { timeAgo } from "@/lib/utils";
import { FileSpreadsheet, FileJson, FileText, Download } from "lucide-react";
import { toast } from "sonner";
import type { ExportFormat } from "@/types/api";

export const Route = createFileRoute("/exports")({
  component: () => (
    <RequireAuth>
      <Exports />
    </RequireAuth>
  ),
});

const formats: {
  format: ExportFormat;
  name: string;
  desc: string;
  icon: typeof FileSpreadsheet;
  color: string;
  bg: string;
  ext: string;
}[] = [
  {
    format: "xlsx",
    name: "Excel",
    desc: "Spreadsheet with one row per business.",
    icon: FileSpreadsheet,
    color: "text-success",
    bg: "bg-success/15 ring-success/30",
    ext: ".xlsx",
  },
  {
    format: "csv",
    name: "CSV",
    desc: "Flat comma-separated, one row per business.",
    icon: FileText,
    color: "text-primary",
    bg: "bg-primary/15 ring-primary/30",
    ext: ".csv",
  },
  {
    format: "json",
    name: "JSON",
    desc: "Structured nested export including all extras.",
    icon: FileJson,
    color: "text-chart-3",
    bg: "bg-chart-3/15 ring-chart-3/30",
    ext: ".json",
  },
];

function formatBytes(bytes: string | number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Exports() {
  const { data, isLoading } = useExports();
  const createExport = useCreateExport();
  const records = data?.exports ?? [];

  function handleExport(format: ExportFormat, name: string): void {
    createExport.mutate(format, {
      onSuccess: (res) => {
        toast.success(`${name} export ready — ${res.export.row_count} rows`);
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <AppShell title="Exports" subtitle="Ship your enriched data anywhere — Excel, CSV or JSON.">
      <div className="grid gap-4 md:grid-cols-3">
        {formats.map((f) => (
          <Card key={f.name} className="group relative overflow-hidden border-border bg-card p-5">
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
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={createExport.isPending}
                  onClick={() => handleExport(f.format, f.name)}
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-6 border-border bg-card">
        <div className="border-b border-border p-5">
          <h3 className="font-display text-base font-semibold">Recent exports</h3>
          <p className="text-xs text-muted-foreground">
            Files are kept for a limited retention window, then cleaned up automatically.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Filename</th>
                <th className="px-2 py-2.5 text-left font-medium">Format</th>
                <th className="px-2 py-2.5 text-left font-medium">Rows</th>
                <th className="px-2 py-2.5 text-left font-medium">Size</th>
                <th className="px-2 py-2.5 text-left font-medium">Created</th>
                <th className="w-16 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && records.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No exports yet — generate one above.
                  </td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-accent/30">
                  <td className="px-4 py-3 font-mono text-xs">{r.filename}</td>
                  <td className="px-2 py-3 uppercase text-xs text-muted-foreground">{r.format}</td>
                  <td className="px-2 py-3 text-xs">{r.row_count.toLocaleString()}</td>
                  <td className="px-2 py-3 text-xs text-muted-foreground">
                    {formatBytes(r.size_bytes)}
                  </td>
                  <td className="px-2 py-3 font-mono text-[10px] text-muted-foreground">
                    {timeAgo(r.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <a href={downloadExportUrl(r.id)} target="_blank" rel="noreferrer">
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </AppShell>
  );
}
