/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { RequireAuth } from "@/components/require-auth";
import { useCurrentUser } from "@/hooks/useAuth";
import { useSettings, useUpdateSettings } from "@/hooks/useSettings";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: () => (
    <RequireAuth>
      <Settings />
    </RequireAuth>
  ),
});

function Settings() {
  const { data: user } = useCurrentUser();
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const isAdmin = user?.roles.includes("admin") ?? false;

  const [concurrency, setConcurrency] = useState(3);
  const [requestDelayMs, setRequestDelayMs] = useState(450);
  const [retryCount, setRetryCount] = useState(2);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [maxBusinessesPerJob, setMaxBusinessesPerJob] = useState(200);
  const [userAgent, setUserAgent] = useState("");
  const [respectRobotsTxt, setRespectRobotsTxt] = useState(true);
  const [followSitemaps, setFollowSitemaps] = useState(true);
  const [crawlWebsite, setCrawlWebsite] = useState(true);
  const [useAiExtraction, setUseAiExtraction] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setConcurrency(settings.concurrency);
    setRequestDelayMs(settings.request_delay_ms);
    setRetryCount(settings.retry_count);
    setTimeoutMs(settings.timeout_ms);
    setMaxBusinessesPerJob(settings.max_businesses_per_job);
    setUserAgent(settings.user_agent);
    setRespectRobotsTxt(settings.respect_robots_txt);
    setFollowSitemaps(settings.follow_sitemaps);
    setCrawlWebsite(settings.crawl_website);
    setUseAiExtraction(settings.use_ai_extraction);
  }, [settings]);

  function handleSave() {
    updateSettings.mutate(
      {
        concurrency,
        request_delay_ms: requestDelayMs,
        retry_count: retryCount,
        timeout_ms: timeoutMs,
        max_businesses_per_job: maxBusinessesPerJob,
        user_agent: userAgent,
        respect_robots_txt: respectRobotsTxt,
        follow_sitemaps: followSitemaps,
        crawl_website: crawlWebsite,
        use_ai_extraction: useAiExtraction,
      },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AppShell title="Settings" subtitle="Crawler behavior for the shared workspace worker.">
      {isLoading ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Loading settings…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="border-border bg-card p-5">
            <h3 className="font-display text-base font-semibold">Crawler tuning</h3>
            {!isAdmin && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Read-only — only admins can change these.
              </p>
            )}
            <div className="mt-4 space-y-5">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs">Concurrency</span>
                  <span className="font-mono text-xs text-primary">{concurrency}</span>
                </div>
                <Slider
                  value={[concurrency]}
                  onValueChange={([v]) => setConcurrency(v)}
                  min={1}
                  max={32}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs">Request delay (ms)</span>
                  <span className="font-mono text-xs text-primary">{requestDelayMs}</span>
                </div>
                <Slider
                  value={[requestDelayMs]}
                  onValueChange={([v]) => setRequestDelayMs(v)}
                  min={0}
                  max={2000}
                  step={50}
                  disabled={!isAdmin}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Respect robots.txt</div>
                  <div className="text-[11px] text-muted-foreground">Skip disallowed paths.</div>
                </div>
                <Switch
                  checked={respectRobotsTxt}
                  onCheckedChange={setRespectRobotsTxt}
                  disabled={!isAdmin}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Follow sitemaps</div>
                  <div className="text-[11px] text-muted-foreground">Discover deeper URLs.</div>
                </div>
                <Switch
                  checked={followSitemaps}
                  onCheckedChange={setFollowSitemaps}
                  disabled={!isAdmin}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Crawl business websites</div>
                  <div className="text-[11px] text-muted-foreground">
                    Off = OSM-only data, no site scraping.
                  </div>
                </div>
                <Switch
                  checked={crawlWebsite}
                  onCheckedChange={setCrawlWebsite}
                  disabled={!isAdmin}
                />
              </div>
            </div>
          </Card>

          <Card className="border-border bg-card p-5">
            <h3 className="font-display text-base font-semibold">Advanced</h3>
            <div className="mt-4 space-y-5">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs">Retry count</span>
                  <span className="font-mono text-xs text-primary">{retryCount}</span>
                </div>
                <Slider
                  value={[retryCount]}
                  onValueChange={([v]) => setRetryCount(v)}
                  min={0}
                  max={10}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs">Timeout (ms)</span>
                  <span className="font-mono text-xs text-primary">{timeoutMs}</span>
                </div>
                <Slider
                  value={[timeoutMs]}
                  onValueChange={([v]) => setTimeoutMs(v)}
                  min={1000}
                  max={120_000}
                  step={1000}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs">Max businesses / job</span>
                  <span className="font-mono text-xs text-primary">{maxBusinessesPerJob}</span>
                </div>
                <Slider
                  value={[maxBusinessesPerJob]}
                  onValueChange={([v]) => setMaxBusinessesPerJob(v)}
                  min={1}
                  max={10_000}
                  step={50}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                  User agent
                </label>
                <Input
                  value={userAgent}
                  onChange={(e) => setUserAgent(e.target.value)}
                  className="bg-input border-border"
                  disabled={!isAdmin}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">AI field extraction</div>
                  <div className="text-[11px] text-muted-foreground">
                    Optional — off by default, no cost when disabled.
                  </div>
                </div>
                <Switch
                  checked={useAiExtraction}
                  onCheckedChange={setUseAiExtraction}
                  disabled={!isAdmin}
                />
              </div>
              <div className="flex items-center gap-4 pt-1 text-[11px] text-muted-foreground">
                <span>
                  Discovery:{" "}
                  <span className="font-mono text-foreground">{settings?.discovery_source}</span>
                </span>
                <span>
                  Map: <span className="font-mono text-foreground">{settings?.map_provider}</span>
                </span>
              </div>
            </div>
          </Card>

          {isAdmin && (
            <div className="lg:col-span-2">
              <Button
                onClick={handleSave}
                disabled={updateSettings.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {updateSettings.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
