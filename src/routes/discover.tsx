/** Authored by: Mohit Singh */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { StatusBadge } from "@/components/status-badge";
import { RequireAuth } from "@/components/require-auth";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCreateJob } from "@/hooks/useJobs";
import { MapPin, Search, Filter, Layers, Radar, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Circle as LeafletCircle, Marker as LeafletMarker } from "leaflet";
import { toast } from "sonner";

export const Route = createFileRoute("/discover")({
  component: () => (
    <RequireAuth>
      <Discover />
    </RequireAuth>
  ),
});

const CATEGORY_PRESETS = [
  "Gym",
  "Library",
  "Coaching Centre",
  "Cafe",
  "Restaurant",
  "Dental",
  "Retail",
];
const DEFAULT_CENTER: [number, number] = [52.52, 13.405];

function Discover() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<LeafletMap | null>(null);
  const circleRef = useRef<LeafletCircle | null>(null);
  const pinRef = useRef<LeafletMarker | null>(null);

  const [radius, setRadius] = useState([5]);
  const [businessType, setBusinessType] = useState("");
  const [location, setLocation] = useState("");
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);

  const navigate = useNavigate();
  const createJob = useCreateJob();
  const { data } = useBusinesses({ limit: 200 });
  const businesses =
    data?.businesses.filter((b) => b.latitude !== null && b.longitude !== null) ?? [];

  useEffect(() => {
    if (typeof window === "undefined" || !mapRef.current || mapInstanceRef.current) return;
    (async () => {
      const L = (await import("leaflet")).default;
      // @ts-expect-error - fix default icon
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });
      const map = L.map(mapRef.current!, { zoomControl: true, attributionControl: false }).setView(
        DEFAULT_CENTER,
        4,
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        setPin({ lat: e.latlng.lat, lng: e.latlng.lng });
      });

      mapInstanceRef.current = map;
    })();

    return () => {
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Real business markers from the master DB — replaces the old hardcoded mock pins.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    let cancelled = false;
    const markers: LeafletMarker[] = [];
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      const cyanDot = L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;border-radius:9999px;background:oklch(0.78 0.16 200);box-shadow:0 0 0 3px oklch(0.78 0.16 200 / 0.25), 0 0 12px oklch(0.78 0.16 200 / 0.8);"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      businesses.forEach((b) => {
        const marker = L.marker([b.latitude as number, b.longitude as number], { icon: cyanDot })
          .addTo(map)
          .bindPopup(
            `<div style="font-family:Inter;font-size:12px"><strong>${b.name}</strong><br/><span style="color:#888">${b.category ?? ""} · ${b.city ?? ""}</span></div>`,
          );
        markers.push(marker);
      });
    })();
    return () => {
      cancelled = true;
      markers.forEach((m) => m.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Search-radius pin + circle, driven by click-to-pin and the radius slider.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !pin) return;
    (async () => {
      const L = (await import("leaflet")).default;
      pinRef.current?.remove();
      circleRef.current?.remove();

      pinRef.current = L.marker([pin.lat, pin.lng]).addTo(map);
      circleRef.current = L.circle([pin.lat, pin.lng], {
        radius: radius[0] * 1000,
        color: "oklch(0.78 0.16 200)",
        fillColor: "oklch(0.78 0.16 200)",
        fillOpacity: 0.08,
        weight: 1.5,
      }).addTo(map);
      map.setView([pin.lat, pin.lng], map.getZoom() < 10 ? 11 : map.getZoom());
    })();
  }, [pin, radius]);

  function handleLaunch() {
    if (businessType.trim() === "") {
      toast.error("Enter a business type first");
      return;
    }
    if (pin === null && location.trim() === "") {
      toast.error("Click the map to pin a location, or type one in");
      return;
    }
    createJob.mutate(
      pin
        ? { businessType, radiusKm: radius[0], centerLat: pin.lat, centerLng: pin.lng }
        : { businessType, radiusKm: radius[0], location },
      {
        onSuccess: () => {
          toast.success(`Crawl launched for "${businessType}"`);
          void navigate({ to: "/jobs" });
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AppShell
      title="Discover"
      subtitle="Click the map to pin a center, pick a radius and category, and launch a crawl."
      actions={
        <Button
          size="sm"
          className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={createJob.isPending}
          onClick={handleLaunch}
        >
          <Zap className="h-3.5 w-3.5" /> {createJob.isPending ? "Launching…" : "Launch crawl"}
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Card className="border-border bg-card p-5">
            <h3 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
              <Filter className="h-3.5 w-3.5 text-primary" /> Search parameters
            </h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Location (or click the map)
                </label>
                <div className="relative">
                  <MapPin className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={location}
                    onChange={(e) => {
                      setLocation(e.target.value);
                      setPin(null);
                    }}
                    placeholder="Berlin, Germany"
                    className="pl-8 bg-input border-border"
                  />
                </div>
                {pin && (
                  <p className="mt-1 font-mono text-[10px] text-primary">
                    Pinned: {pin.lat.toFixed(4)}, {pin.lng.toFixed(4)}
                  </p>
                )}
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Radius
                  </label>
                  <span className="font-mono text-xs text-primary">{radius[0]} km</span>
                </div>
                <Slider value={radius} onValueChange={setRadius} min={1} max={50} step={1} />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Category
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORY_PRESETS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setBusinessType(c)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${businessType === c ? "border-primary bg-primary/15 text-primary" : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Business type
                </label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value)}
                    placeholder="e.g. specialty roaster"
                    className="pl-8 bg-input border-border"
                  />
                </div>
              </div>
              <Button
                className="w-full gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={createJob.isPending}
                onClick={handleLaunch}
              >
                <Radar className="h-3.5 w-3.5" /> {createJob.isPending ? "Launching…" : "Scan area"}
              </Button>
            </div>
          </Card>

          <Card className="border-border bg-card p-5">
            <h3 className="mb-3 font-display text-sm font-semibold">
              Master DB · {businesses.length} shown on map
            </h3>
            <div className="max-h-[380px] space-y-2 overflow-y-auto pr-1">
              {businesses.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No businesses yet — launch a crawl to start populating the map.
                </p>
              )}
              {businesses.slice(0, 30).map((b) => (
                <div
                  key={b.id}
                  className="flex items-start gap-2.5 rounded-md border border-border/60 bg-background/40 p-2.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{b.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {b.category ?? "—"} · {b.city ?? "—"}
                    </div>
                  </div>
                  <StatusBadge status={b.enrichment_status} />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="relative overflow-hidden border-border bg-card p-0">
          <div ref={mapRef} className="h-[720px] w-full" />
          <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-2">
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card/85 px-3 py-2 backdrop-blur-md">
              <Layers className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium">Live OSM · {businesses.length} markers</span>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
