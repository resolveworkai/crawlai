/** Authored by: Mohit Singh */
import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RequireAuth } from "@/components/require-auth";
import { useCampaigns } from "@/hooks/useMarketing";
import { timeAgo } from "@/lib/utils";
import { Mail, MessageCircle, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/marketing/campaigns")({
  component: () => (
    <RequireAuth>
      <Campaigns />
    </RequireAuth>
  ),
});

function Campaigns() {
  const { data: campaigns = [] } = useCampaigns();
  return (
    <AppShell title="Campaigns" subtitle="Every WhatsApp and Email outreach run.">
      <div className="mb-3">
        <Button asChild size="sm" variant="ghost" className="gap-1 text-muted-foreground">
          <Link to="/marketing">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to composer
          </Link>
        </Button>
      </div>
      <Card className="border-border bg-card">
        <div className="divide-y divide-border">
          {campaigns.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">No campaigns yet.</p>
          )}
          {campaigns.map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-2">
                {c.channel === "email" ? (
                  <Mail className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <MessageCircle className="h-4 w-4 shrink-0 text-success" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {c.subject ?? c.body.slice(0, 60)}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {c.id.slice(0, 8)} · {c.channel} · {timeAgo(c.created_at)}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className="capitalize text-muted-foreground">{c.status}</span>
                <span className="text-success">{c.sent_count} sent</span>
                {c.failed_count > 0 && (
                  <span className="text-destructive">{c.failed_count} failed</span>
                )}
                {c.skipped_count > 0 && (
                  <span className="text-warning">{c.skipped_count} skipped</span>
                )}
                <span className="text-muted-foreground">/ {c.total_count}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </AppShell>
  );
}
