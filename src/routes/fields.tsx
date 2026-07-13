/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RequireAuth } from "@/components/require-auth";
import {
  useCreateDynamicField,
  useDeleteDynamicField,
  useDynamicFields,
  useUpdateDynamicField,
} from "@/hooks/useDynamicFields";
import { Sparkles, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { DynamicFieldType } from "@/types/api";

export const Route = createFileRoute("/fields")({
  component: () => (
    <RequireAuth>
      <Fields />
    </RequireAuth>
  ),
});

const typeColors: Record<string, string> = {
  text: "bg-primary/15 text-primary ring-primary/30",
  number: "bg-chart-3/15 text-chart-3 ring-chart-3/30",
  boolean: "bg-success/15 text-success ring-success/30",
  list: "bg-warning/15 text-warning ring-warning/30",
  url: "bg-chart-5/15 text-chart-5 ring-chart-5/30",
};

function NewFieldDialog() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [fieldType, setFieldType] = useState<DynamicFieldType>("text");
  const createField = useCreateDynamicField();

  function reset() {
    setKey("");
    setLabel("");
    setPrompt("");
    setFieldType("text");
  }

  function handleSubmit() {
    createField.mutate(
      { key, label, prompt, fieldType },
      {
        onSuccess: () => {
          toast.success(`Field "${label}" created`);
          reset();
          setOpen(false);
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
          className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New field
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New dynamic field</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Label
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Accepts Wholesale"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Key (extras.&lt;key&gt;)
            </label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="wholesale"
              className="font-mono"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Type
            </label>
            <Select value={fieldType} onValueChange={(v) => setFieldType(v as DynamicFieldType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="boolean">Boolean</SelectItem>
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="url">URL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Extraction prompt
            </label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Does this business offer wholesale or B2B pricing on their website?"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={
              createField.isPending ||
              key.trim() === "" ||
              label.trim() === "" ||
              prompt.trim() === ""
            }
          >
            {createField.isPending ? "Creating…" : "Create field"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fields() {
  const { data: fields, isLoading } = useDynamicFields();
  const updateField = useUpdateDynamicField();
  const deleteField = useDeleteDynamicField();

  return (
    <AppShell
      title="Dynamic Fields"
      subtitle="Teach the AI what to extract. Write a prompt, choose a type — every crawled site gets structured data back."
      actions={<NewFieldDialog />}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {isLoading && (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Loading fields…
            </div>
          )}
          {!isLoading && fields?.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              No dynamic fields yet — create one to start extracting custom data.
            </div>
          )}
          {fields?.map((f) => (
            <Card
              key={f.id}
              className="border-border bg-card p-5 transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="font-display text-base font-semibold">{f.label}</h3>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${typeColors[f.field_type]}`}
                    >
                      {f.field_type}
                    </span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      extras.{f.key}
                    </code>
                  </div>
                  <p className="mt-3 rounded-md border border-border bg-background/40 p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
                    <span className="text-primary">▸</span> {f.prompt}
                  </p>
                  <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
                    <span className={f.enabled ? "text-success" : "text-muted-foreground"}>
                      {f.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Switch
                    checked={f.enabled}
                    onCheckedChange={(enabled) =>
                      updateField.mutate(
                        { id: f.id, patch: { enabled } },
                        { onError: (err) => toast.error(err.message) },
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete field "${f.label}"?`)) {
                        deleteField.mutate(f.id, { onError: (err) => toast.error(err.message) });
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Card className="border-border bg-card p-5 h-fit sticky top-20">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary/30 to-chart-3/30 ring-1 ring-primary/30">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h3 className="font-display text-sm font-semibold">How dynamic fields work</h3>
              <p className="text-[11px] text-muted-foreground">Prompt → JSON schema → extraction</p>
            </div>
          </div>

          <ol className="mt-4 space-y-3 text-xs text-muted-foreground">
            {[
              ["Write a natural-language prompt", "Describe exactly what to pull from a page."],
              ["Pick a type", "Text, number, boolean, list or URL — sets the JSON schema."],
              ["Enable on jobs", "New crawls will include this field in every extraction."],
              ["Access as extras.{key}", "Available in filters, exports and the API."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <div>
                  <div className="text-foreground">{t}</div>
                  <div className="mt-0.5">{d}</div>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-5 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="text-[11px] font-medium text-primary">AI extraction</div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              Optional and off by default (Settings → AI field extraction). Provider-agnostic —
              Ollama (free/local) or any OpenAI-compatible endpoint.
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
