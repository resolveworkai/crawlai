import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  enriched: "bg-success/15 text-success ring-success/30",
  completed: "bg-success/15 text-success ring-success/30",
  running: "bg-primary/15 text-primary ring-primary/30",
  crawling: "bg-primary/15 text-primary ring-primary/30",
  queued: "bg-muted text-muted-foreground ring-border",
  paused: "bg-warning/15 text-warning ring-warning/30",
  failed: "bg-destructive/15 text-destructive ring-destructive/30",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = styles[status] ?? styles.queued;
  const pulse = status === "running" || status === "crawling";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset capitalize",
        cls,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current", pulse && "animate-pulse")} />
      {status}
    </span>
  );
}
