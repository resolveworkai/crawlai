/** Authored by: Mohit Singh */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { useCreateJob } from "@/hooks/useJobs";
import { Plus, Zap } from "lucide-react";
import { toast } from "sonner";

/**
 * Quick-launch modal for the AppShell header — same POST /jobs call Discover's "Scan area"
 * button uses (see md/plans/0001-*.md's design-spec finding #5). Geocoding happens server-side
 * (createJobSchema accepts a bare `location` string), so this needs no map.
 */
export function NewCrawlDialog() {
  const [open, setOpen] = useState(false);
  const [businessType, setBusinessType] = useState("");
  const [location, setLocation] = useState("");
  const [radius, setRadius] = useState([5]);
  const createJob = useCreateJob();
  const navigate = useNavigate();

  function reset() {
    setBusinessType("");
    setLocation("");
    setRadius([5]);
  }

  function handleSubmit() {
    createJob.mutate(
      { businessType, location, radiusKm: radius[0] },
      {
        onSuccess: () => {
          toast.success(`Crawl launched for "${businessType}"`);
          reset();
          setOpen(false);
          void navigate({ to: "/jobs" });
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> New crawl
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch a new crawl</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-1.5 block text-[11px] uppercase tracking-wide">
              Business type
            </Label>
            <Input
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              placeholder="gym, library, coaching centre…"
            />
          </div>
          <div>
            <Label className="mb-1.5 block text-[11px] uppercase tracking-wide">Location</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Berlin, Germany"
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="text-[11px] uppercase tracking-wide">Radius</Label>
              <span className="font-mono text-xs text-primary">{radius[0]} km</span>
            </div>
            <Slider value={radius} onValueChange={setRadius} min={1} max={50} step={1} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={createJob.isPending || businessType.trim() === "" || location.trim() === ""}
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Zap className="h-3.5 w-3.5" /> {createJob.isPending ? "Launching…" : "Launch crawl"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
