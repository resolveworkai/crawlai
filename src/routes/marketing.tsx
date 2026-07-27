/** Authored by: Mohit Singh */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RequireAuth } from "@/components/require-auth";
import { useOcrJobs } from "@/hooks/useOcrCrawl";
import {
  campaignExportUrl,
  campaignVcardUrl,
  useAddTemplateImage,
  useCampaign,
  useContacts,
  useCreateCampaign,
  useCreateContact,
  useEmailCredentials,
  useMarkRecipientSent,
  usePreviewRecipients,
  useSaveEmailCredentials,
  useSendCampaign,
  useTemplateImages,
  useTemplates,
  useTestEmail,
  type RecipientSource,
} from "@/hooks/useMarketing";
import {
  useAgentStatus,
  useAgentTestSend,
  useStartAutomatedSend,
  useStopAutomatedSend,
} from "@/hooks/useWhatsappAgent";
import type {
  CampaignRecipient,
  MarketingRecipient,
  MessageChannel,
  MessageTemplate,
} from "@/types/api";
import { toast } from "sonner";
import {
  AlertTriangle,
  Contact,
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Mail,
  MessageCircle,
  Paperclip,
  Plus,
  Send,
  Square,
  Upload,
  Zap,
} from "lucide-react";

export const Route = createFileRoute("/marketing")({
  component: () => (
    <RequireAuth>
      <Marketing />
    </RequireAuth>
  ),
});

const PLACEHOLDERS = ["business_name", "business_type", "location", "city"] as const;

function renderPreview(text: string, r: MarketingRecipient | undefined): string {
  if (!r) return text;
  const city = (r.location ?? "").split(",")[0]?.trim() ?? "";
  return text
    .replace(/\{business_name\}/g, r.businessName)
    .replace(/\{business_type\}/g, r.businessType ?? "")
    .replace(/\{location\}/g, r.location ?? "")
    .replace(/\{city\}/g, city);
}

// Most-common businessType among the loaded recipients — used to recommend a matching template
// first (case-insensitive; OCR/CSV business types are free text, not a fixed enum).
function dominantBusinessType(recipients: MarketingRecipient[]): string | null {
  const counts = new Map<string, number>();
  for (const r of recipients) {
    if (!r.businessType) continue;
    const key = r.businessType.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function Marketing() {
  const [channel, setChannel] = useState<MessageChannel>("whatsapp");
  return (
    <AppShell
      title="Marketing"
      subtitle="Reach discovered business owners over WhatsApp (click-to-chat) and Email to onboard them."
    >
      <Tabs value={channel} onValueChange={(v) => setChannel(v as MessageChannel)}>
        <TabsList>
          <TabsTrigger value="whatsapp" className="gap-1.5">
            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          </TabsTrigger>
          <TabsTrigger value="email" className="gap-1.5">
            <Mail className="h-3.5 w-3.5" /> Email
          </TabsTrigger>
        </TabsList>
        <TabsContent value="whatsapp" className="mt-4">
          <ChannelComposer channel="whatsapp" />
        </TabsContent>
        <TabsContent value="email" className="mt-4">
          <ChannelComposer channel="email" />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

// One composer instance per channel (independent recipient/message/campaign state).
function ChannelComposer({ channel }: { channel: MessageChannel }) {
  const [recipients, setRecipients] = useState<MarketingRecipient[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined);
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);

  const preview = recipients[0];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RecipientStep
        channel={channel}
        onLoaded={setRecipients}
        recipients={recipients}
        onAddOne={(r) => setRecipients((prev) => [...prev, r])}
      />
      <MessageStep
        channel={channel}
        subject={subject}
        body={body}
        setSubject={setSubject}
        setBody={setBody}
        previewRecipient={preview}
        recommendedType={dominantBusinessType(recipients)}
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
      />
      {channel === "email" && <EmailCredsCard />}
      <SendStep
        channel={channel}
        recipients={recipients}
        subject={subject}
        body={body}
        templateId={selectedTemplateId}
        campaignId={campaignId}
        setCampaignId={setCampaignId}
      />
      {campaignId && (
        <div className="lg:col-span-2">
          <SendLogPanel channel={channel} campaignId={campaignId} />
        </div>
      )}
    </div>
  );
}

// Live per-message send log — the counters alone don't tell you WHICH number a message went to or
// why one failed. Rows come from campaign_recipients (the server-side source of truth, so it covers
// manual click-to-chat sends too and survives a reload), enriched with the local agent's in-memory
// log for the failure text of an in-flight automated run.
function SendLogPanel({ channel, campaignId }: { channel: MessageChannel; campaignId: string }) {
  const agent = useAgentStatus({ enabled: channel === "whatsapp", poll: true });
  const agentRunning = Boolean(agent.data?.running && agent.data.campaignId === campaignId);
  const { data } = useCampaign(campaignId, agentRunning);

  const recipients = data?.recipients ?? [];
  const done = recipients.filter((r) => r.status === "sent" || r.status === "failed");
  const sent = done.filter((r) => r.status === "sent").length;
  const failed = done.filter((r) => r.status === "failed").length;

  // Newest first — during a live run the operator is watching the tail, not the head.
  const rows = [...done].sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));

  return (
    <Card className="border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold">
          Send log{" "}
          {agentRunning && (
            <span className="ml-1 animate-pulse text-[11px] font-normal text-success">● live</span>
          )}
        </h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-success">{sent} sent</span>
          {failed > 0 && <span className="text-destructive">{failed} failed</span>}
          <span className="text-muted-foreground">of {recipients.length}</span>
        </div>
      </div>

      {agentRunning && agent.data?.lastMessage && (
        <p className="mt-1 text-[11px] text-muted-foreground">{agent.data.lastMessage}</p>
      )}

      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing sent yet — messages appear here as they go out, with the number and the result.
        </p>
      ) : (
        <div className="mt-3 max-h-72 overflow-auto rounded border border-border">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">Time</th>
                <th className="px-2 py-1 text-left">Business</th>
                <th className="px-2 py-1 text-left">
                  {channel === "whatsapp" ? "To (number)" : "To (email)"}
                </th>
                <th className="px-2 py-1 text-left">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                    {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : "—"}
                  </td>
                  <td className="px-2 py-1">{r.business_name}</td>
                  <td className="px-2 py-1 font-mono">
                    {(channel === "whatsapp" ? r.phone : r.email) ?? "—"}
                  </td>
                  <td className="px-2 py-1">
                    {r.status === "sent" ? (
                      <span className="text-success">✓ sent</span>
                    ) : (
                      <span className="text-destructive">
                        ✗ failed{r.error ? ` — ${r.error}` : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- Step 1: recipients ---
function RecipientStep({
  channel,
  recipients,
  onLoaded,
  onAddOne,
}: {
  channel: MessageChannel;
  recipients: MarketingRecipient[];
  onLoaded: (r: MarketingRecipient[]) => void;
  onAddOne: (r: MarketingRecipient) => void;
}) {
  const { data: ocrJobs = [] } = useOcrJobs();
  const readyJobs = ocrJobs.filter((j) => j.status === "ready");
  const { data: contacts = [] } = useContacts();
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [upload, setUpload] = useState<{ filename: string; base64: string } | undefined>();
  const previewMut = usePreviewRecipients();
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      setUpload({ filename: file.name, base64 });
      toast.success(`Loaded ${file.name}`);
    };
    reader.readAsDataURL(file);
  }

  function load() {
    const source: RecipientSource = {};
    if (upload) source.upload = upload;
    if (selectedJobs.length) source.ocrJobIds = selectedJobs;
    if (selectedContacts.length) source.contactIds = selectedContacts;
    if (!source.upload && !source.ocrJobIds && !source.contactIds) {
      toast.error("Upload a file, pick an OCR job, or pick a saved contact first");
      return;
    }
    previewMut.mutate(source, {
      onSuccess: (res) => {
        onLoaded(res.recipients);
        toast.success(
          `${res.total} unique businesses (${res.withPhone} phone, ${res.withEmail} email)`,
        );
      },
      onError: (e) => toast.error(e.message),
    });
  }

  const usable = recipients.filter((r) => (channel === "whatsapp" ? r.phone : r.email)).length;

  return (
    <Card className="border-border bg-card p-5">
      <h3 className="font-display text-base font-semibold">1 · Recipients</h3>
      <p className="text-xs text-muted-foreground">
        Deduped to unique businesses (type + location kept).
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">
            Upload CSV / XLSX (e.g. an OCR export)
          </label>
          <div className="mt-1 flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 border-border"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" /> {upload ? upload.filename : "Choose file"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground">…and/or pick finished OCR job(s)</label>
          <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded border border-border p-2">
            {readyJobs.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No finished OCR jobs.</p>
            )}
            {readyJobs.map((j) => (
              <label key={j.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedJobs.includes(j.id)}
                  onChange={(e) =>
                    setSelectedJobs((prev) =>
                      e.target.checked ? [...prev, j.id] : prev.filter((x) => x !== j.id),
                    )
                  }
                />
                <span className="truncate">
                  {j.query} · {j.location}{" "}
                  <span className="text-muted-foreground">({j.captured_count})</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground">…and/or pick saved contacts</label>
          <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded border border-border p-2">
            {contacts.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No saved contacts yet — add one below.
              </p>
            )}
            {contacts.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedContacts.includes(c.id)}
                  onChange={(e) =>
                    setSelectedContacts((prev) =>
                      e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                    )
                  }
                />
                <span className="truncate">
                  {c.business_name}
                  {c.business_type && (
                    <span className="text-muted-foreground"> · {c.business_type}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        <Button size="sm" disabled={previewMut.isPending} onClick={load} className="gap-1.5">
          <Contact className="h-3.5 w-3.5" /> Load recipients
        </Button>

        <AddContactForm onAdded={onAddOne} />
      </div>

      {recipients.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">
            {recipients.length} businesses · <b>{usable}</b> reachable by{" "}
            {channel === "whatsapp" ? "WhatsApp" : "email"}
          </p>
          <div className="mt-2 max-h-48 overflow-auto rounded border border-border">
            <table className="w-full text-[11px]">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left">Business</th>
                  <th className="px-2 py-1 text-left">Type</th>
                  <th className="px-2 py-1 text-left">
                    {channel === "whatsapp" ? "Phone" : "Email"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipients.slice(0, 100).map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1">{r.businessName}</td>
                    <td className="px-2 py-1 text-muted-foreground">{r.businessType ?? "—"}</td>
                    <td className="px-2 py-1 font-mono">
                      {(channel === "whatsapp" ? r.phone : r.email) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// Quick "type in a business you already know" form — saves it to the reusable Contacts list
// (server normalizes phone/email) and immediately merges it into the current draft.
function AddContactForm({ onAdded }: { onAdded: (r: MarketingRecipient) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    businessName: "",
    businessType: "",
    location: "",
    phone: "",
    email: "",
  });
  const create = useCreateContact();

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    if (!form.businessName.trim()) return toast.error("Business name is required");
    create.mutate(
      {
        businessName: form.businessName.trim(),
        businessType: form.businessType.trim() || null,
        location: form.location.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
      },
      {
        onSuccess: ({ contact }) => {
          onAdded({
            businessName: contact.business_name,
            businessType: contact.business_type,
            location: contact.location,
            phone: contact.phone,
            email: contact.email,
          });
          toast.success(`Added ${contact.business_name}`);
          setForm({ businessName: "", businessType: "", location: "", phone: "", email: "" });
          setOpen(false);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" /> Add a business manually
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded border border-border p-2">
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          placeholder="Business name *"
          value={form.businessName}
          onChange={(e) => set("businessName", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Type (e.g. Gym)"
          value={form.businessType}
          onChange={(e) => set("businessType", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Location"
          value={form.location}
          onChange={(e) => set("location", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Phone"
          value={form.phone}
          onChange={(e) => set("phone", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Email"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          className="col-span-2 h-8 bg-input text-xs"
        />
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={create.isPending} onClick={submit}>
          Save &amp; add to draft
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// --- Step 2: message ---
function MessageStep({
  channel,
  subject,
  body,
  setSubject,
  setBody,
  previewRecipient,
  recommendedType,
  selectedTemplateId,
  setSelectedTemplateId,
}: {
  channel: MessageChannel;
  subject: string;
  body: string;
  setSubject: (v: string) => void;
  setBody: (v: string) => void;
  previewRecipient: MarketingRecipient | undefined;
  recommendedType: string | null;
  selectedTemplateId: string | undefined;
  setSelectedTemplateId: (id: string | undefined) => void;
}) {
  const { data: templates = [] } = useTemplates(channel);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const recommended = recommendedType
    ? templates.filter((t) => t.business_type?.toLowerCase() === recommendedType)
    : [];
  const other = templates.filter((t) => !recommended.includes(t));

  function insert(token: string) {
    const el = bodyRef.current;
    const t = `{${token}}`;
    if (!el) return setBody(body + t);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setBody(body.slice(0, start) + t + body.slice(end));
  }

  function applyTemplate(t: MessageTemplate) {
    setBody(t.body);
    if (t.subject) setSubject(t.subject);
    setSelectedTemplateId(t.id);
  }

  return (
    <Card className="border-border bg-card p-5">
      <h3 className="font-display text-base font-semibold">2 · Message</h3>
      <p className="text-xs text-muted-foreground">
        {channel === "email"
          ? "HTML body + subject."
          : "Plain text (opens pre-filled in WhatsApp)."}{" "}
        Use placeholders.
      </p>

      <div className="mt-4 space-y-3">
        {templates.length > 0 && (
          <select
            className="h-9 w-full rounded-md border border-border bg-input px-2 text-sm"
            value={selectedTemplateId ?? ""}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) applyTemplate(t);
              else setSelectedTemplateId(undefined);
            }}
          >
            <option value="">Load a saved template…</option>
            {recommended.length > 0 && (
              <optgroup label={`Recommended for ${recommendedType}`}>
                {recommended.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={recommended.length > 0 ? "Other templates" : "Templates"}>
              {other.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.business_type ? ` (${t.business_type})` : ""}
                </option>
              ))}
            </optgroup>
          </select>
        )}

        {channel === "email" && (
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (e.g. Grow {business_name} with our portal)"
            className="h-9 bg-input"
          />
        )}

        <div className="flex flex-wrap gap-1">
          {PLACEHOLDERS.map((p) => (
            <button
              key={p}
              onClick={() => insert(p)}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {`{${p}}`}
            </button>
          ))}
        </div>

        <Textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={channel === "email" ? 8 : 5}
          placeholder={
            channel === "email"
              ? '<p>Hi {business_name},</p><p>...</p>  (HTML; use <img src="cid:logo"> for inline images)'
              : "Hi {business_name} in {city}! We'd love to onboard you..."
          }
          className="bg-input font-mono text-xs"
        />

        {body && (
          <div className="rounded border border-border bg-muted/20 p-2">
            <p className="mb-1 text-[10px] uppercase text-muted-foreground">
              Preview (first recipient)
            </p>
            {channel === "email" ? (
              <div
                className="prose-sm text-xs"
                dangerouslySetInnerHTML={{ __html: renderPreview(body, previewRecipient) }}
              />
            ) : (
              <p className="whitespace-pre-wrap text-xs">{renderPreview(body, previewRecipient)}</p>
            )}
          </div>
        )}

        {channel === "email" && <AttachmentsSection templateId={selectedTemplateId} />}
      </div>
    </Card>
  );
}

// Inline images (cid, referenced via <img src="cid:...">) + plain attachments (e.g. a PDF brochure)
// for the currently-selected template. Attachments live on the template row, so they're only
// available once a saved template is picked — an ad-hoc body has nowhere to persist the bytes.
function AttachmentsSection({ templateId }: { templateId: string | undefined }) {
  const { data: images = [] } = useTemplateImages(templateId);
  const addImage = useAddTemplateImage();
  const inlineRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  function upload(file: File, isInline: boolean) {
    if (!templateId) {
      toast.error("Pick or save a template first — attachments are stored on the template.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      addImage.mutate(
        {
          templateId,
          cid: `${isInline ? "img" : "file"}-${Date.now()}`,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          base64,
          isInline,
        },
        {
          onSuccess: () => toast.success(`Added ${file.name}`),
          onError: (e) => toast.error(e.message),
        },
      );
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="rounded border border-border p-2">
      <p className="mb-1.5 text-[10px] uppercase text-muted-foreground">
        Attachments {!templateId && "(save/pick a template first)"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-border text-[11px]"
          disabled={!templateId}
          onClick={() => inlineRef.current?.click()}
        >
          <ImageIcon className="h-3 w-3" /> Inline image
        </Button>
        <input
          ref={inlineRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], true)}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-border text-[11px]"
          disabled={!templateId}
          onClick={() => attachRef.current?.click()}
        >
          <Paperclip className="h-3 w-3" /> Attach a file
        </Button>
        <input
          ref={attachRef}
          type="file"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], false)}
        />
      </div>
      {images.length > 0 && (
        <ul className="mt-2 space-y-1">
          {images.map((img) => (
            <li
              key={img.id}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              {img.isInline ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              {img.filename}
              <span className="text-[10px]">{img.isInline ? "(inline)" : "(attachment)"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Email SMTP credentials ---
function EmailCredsCard() {
  const { data } = useEmailCredentials();
  const save = useSaveEmailCredentials();
  const test = useTestEmail();
  const creds = data?.credentials;
  const [form, setForm] = useState({
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
    smtpPassword: "",
    fromName: "",
    fromEmail: "",
    orgAddress: "",
  });
  const [testTo, setTestTo] = useState("");

  const set = (k: keyof typeof form, v: string | number | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card className="border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold">Email account (SMTP)</h3>
        {creds?.verified && <span className="text-[11px] text-success">✓ verified</span>}
      </div>
      {data && !data.encryptionAvailable && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-warning">
          <AlertTriangle className="h-3 w-3" /> MESSAGING_ENCRYPTION_KEY not set — cannot save
          credentials.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Input
          placeholder="SMTP host (smtp.gmail.com)"
          defaultValue={creds?.smtpHost ?? ""}
          onChange={(e) => set("smtpHost", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Port"
          type="number"
          defaultValue={creds?.smtpPort ?? 587}
          onChange={(e) => set("smtpPort", Number(e.target.value))}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="SMTP user"
          defaultValue={creds?.smtpUser ?? ""}
          onChange={(e) => set("smtpUser", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Password / app password"
          type="password"
          onChange={(e) => set("smtpPassword", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="From name"
          defaultValue={creds?.fromName ?? ""}
          onChange={(e) => set("fromName", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="From email"
          defaultValue={creds?.fromEmail ?? ""}
          onChange={(e) => set("fromEmail", e.target.value)}
          className="h-8 bg-input text-xs"
        />
        <Input
          placeholder="Org address (footer)"
          defaultValue={creds?.orgAddress ?? ""}
          onChange={(e) => set("orgAddress", e.target.value)}
          className="col-span-2 h-8 bg-input text-xs"
        />
        <label className="col-span-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Switch checked={form.smtpSecure} onCheckedChange={(v) => set("smtpSecure", v)} /> Use TLS
          (port 465)
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !(data?.encryptionAvailable ?? false)}
          onClick={() =>
            save.mutate(
              { ...form, smtpPassword: form.smtpPassword || undefined },
              {
                onSuccess: () => toast.success("Saved — send a test to verify"),
                onError: (e) => toast.error(e.message),
              },
            )
          }
        >
          Save credentials
        </Button>
        <Input
          placeholder="test to: you@x.com"
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          className="h-8 w-44 bg-input text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 border-border"
          disabled={test.isPending || !testTo}
          onClick={() =>
            test.mutate(testTo, {
              onSuccess: () => toast.success("Test sent!"),
              onError: (e) => toast.error(e.message),
            })
          }
        >
          Send test
        </Button>
      </div>
    </Card>
  );
}

// --- Step 3: send ---
function SendStep({
  channel,
  recipients,
  subject,
  body,
  templateId,
  campaignId,
  setCampaignId,
}: {
  channel: MessageChannel;
  recipients: MarketingRecipient[];
  subject: string;
  body: string;
  templateId: string | undefined;
  campaignId: string | undefined;
  setCampaignId: (id: string) => void;
}) {
  const create = useCreateCampaign();
  const send = useSendCampaign();
  const { data: detail } = useCampaign(campaignId);
  const [wizardOpen, setWizardOpen] = useState(false);

  function createCampaign(then?: (id: string) => void) {
    if (recipients.length === 0) return toast.error("Load recipients first");
    if (!body.trim()) return toast.error("Write a message first");
    if (channel === "email" && !subject.trim()) return toast.error("Add a subject");
    create.mutate(
      {
        channel,
        templateId: templateId ?? null,
        subject: channel === "email" ? subject : null,
        body,
        recipients,
      },
      {
        onSuccess: ({ campaign }) => {
          setCampaignId(campaign.id);
          then?.(campaign.id);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }

  return (
    <Card className="border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold">3 · Send</h3>
        {channel === "whatsapp" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setWizardOpen(true)}
          >
            How it works
          </Button>
        )}
      </div>

      {channel === "email" ? (
        <div className="mt-4 space-y-3">
          <Button
            disabled={create.isPending || send.isPending}
            onClick={() =>
              createCampaign((id) =>
                send.mutate(id, { onSuccess: () => toast.success("Sending…") }),
              )
            }
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" /> Create &amp; send campaign
          </Button>
          {detail && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium capitalize text-foreground">
                {detail.campaign.status}
              </span>{" "}
              · sent {detail.campaign.sent_count}/{detail.campaign.total_count} · failed{" "}
              {detail.campaign.failed_count} · skipped {detail.campaign.skipped_count}
            </div>
          )}
          {campaignId && <ReportRow campaignId={campaignId} />}
          {campaignId && <FailedRecipientsPanel campaignId={campaignId} />}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {!campaignId ? (
            <Button
              disabled={create.isPending}
              onClick={() => createCampaign()}
              className="gap-1.5"
            >
              <MessageCircle className="h-3.5 w-3.5" /> Prepare WhatsApp links
            </Button>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                <a href={campaignVcardUrl(campaignId)} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                    <Download className="h-3.5 w-3.5" /> Download vCard
                  </Button>
                </a>
                <ReportRow campaignId={campaignId} />
              </div>
              <AutomatedSendPanel campaignId={campaignId} />
              <p className="text-[11px] text-muted-foreground">
                Or click each business below to open WhatsApp with the message pre-filled, then
                press Send.
              </p>
              <WhatsAppRecipientList campaignId={campaignId} />
              <FailedRecipientsPanel campaignId={campaignId} />
            </>
          )}
        </div>
      )}

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sending WhatsApp messages</DialogTitle>
            <DialogDescription>
              Safe, manual — no automation, so your number can't get banned.
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Write your curated message with <code>{"{business_name}"}</code> placeholders above.
            </li>
            <li>
              <b>Download the vCard</b> and import it into your phone — every business is saved by
              name.
            </li>
            <li>
              Click each business's <b>Open WhatsApp</b> link — the chat opens with your message
              pre-filled; press Send.
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            <Link to="/marketing/campaigns" className="text-primary hover:underline">
              View past campaigns →
            </Link>
          </p>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ReportRow({ campaignId }: { campaignId: string }) {
  return (
    <a href={campaignExportUrl(campaignId)} target="_blank" rel="noreferrer">
      <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
        <FileSpreadsheet className="h-3.5 w-3.5" /> Download report (.xlsx)
      </Button>
    </a>
  );
}

// Shown for either channel once a campaign exists — the excel report (ReportRow) has the full
// detail, but seeing failures inline means the operator doesn't have to download anything just to
// know what went wrong.
function FailedRecipientsPanel({ campaignId }: { campaignId: string }) {
  const { data } = useCampaign(campaignId);
  const failed: CampaignRecipient[] = (data?.recipients ?? []).filter((r) => r.status === "failed");
  if (failed.length === 0) return null;

  return (
    <div className="rounded border border-destructive/30 bg-destructive/5 p-2">
      <p className="mb-1.5 text-[10px] uppercase text-destructive">Failed ({failed.length})</p>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {failed.map((r) => (
          <li key={r.id} className="text-[11px]">
            <span className="font-medium">{r.business_name}</span>{" "}
            <span className="text-muted-foreground">— {r.error ?? "unknown error"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Talks to the local automation agent (backend/whatsapp-sender), a separate process the operator
// runs on their own machine — see its README. "Agent not detected" is the expected default state,
// not an error; only shows real controls once it's actually reachable.
function AutomatedSendPanel({ campaignId }: { campaignId: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = useAgentStatus({ enabled: true, poll: true });
  const start = useStartAutomatedSend();
  const stop = useStopAutomatedSend();
  const testSend = useAgentTestSend();

  const agentUnreachable = status.isError;
  const thisRunning = status.data?.running && status.data.campaignId === campaignId;
  const otherRunning = status.data?.running && status.data.campaignId !== campaignId;

  return (
    <div className="rounded border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Automated send (local agent)</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          disabled={agentUnreachable || testSend.isPending}
          onClick={() =>
            testSend.mutate(undefined, {
              onSuccess: () => toast.success("Trial message sent — check the test phone"),
              onError: (e) => toast.error(e.message),
            })
          }
        >
          Send test
        </Button>
      </div>

      {agentUnreachable ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Agent not detected. Run <code className="rounded bg-muted px-1">npm run agent</code> in{" "}
          <code className="rounded bg-muted px-1">backend/whatsapp-sender</code> (see its README),
          then reload this page.
        </p>
      ) : thisRunning ? (
        <div className="mt-1.5 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            {status.data?.lastMessage} ({status.data?.sent}/{status.data?.total} sent,{" "}
            {status.data?.failed} failed)
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-destructive text-[11px] text-destructive"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            <Square className="h-3 w-3" /> Stop
          </Button>
        </div>
      ) : otherRunning ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Another campaign is currently sending via the agent — wait for it to finish.
        </p>
      ) : (
        <Button size="sm" className="mt-1.5 h-8 gap-1.5" onClick={() => setConfirmOpen(true)}>
          <Zap className="h-3.5 w-3.5" /> Start Automated Send
        </Button>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start automated WhatsApp send?</DialogTitle>
            <DialogDescription>
              This automates a real WhatsApp Web session outside WhatsApp's Business API terms. Your
              number can be rate-limited or banned. Make sure you've run a trial send first.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            The local agent will open each pending recipient's chat and press Send, with a
            randomized delay and a daily cap between messages.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={start.isPending}
              onClick={() =>
                start.mutate(
                  { campaignId },
                  {
                    onSuccess: () => {
                      setConfirmOpen(false);
                      toast.success("Automated send started");
                    },
                    onError: (e) => toast.error(e.message),
                  },
                )
              }
            >
              I understand — start
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WhatsAppRecipientList({ campaignId }: { campaignId: string }) {
  const { data } = useCampaign(campaignId);
  const mark = useMarkRecipientSent();
  const withLink = (data?.recipients ?? []).filter((r) => r.wa_link);

  return (
    <div className="max-h-64 divide-y divide-border overflow-y-auto rounded border border-border">
      {withLink.length === 0 && (
        <p className="p-3 text-xs text-muted-foreground">No recipients with a usable phone.</p>
      )}
      {withLink.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 truncate">
            {r.business_name} <span className="font-mono text-muted-foreground">{r.phone}</span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {r.status === "sent" ? (
              <span className="text-[10px] text-success">sent ✓</span>
            ) : (
              <a
                href={r.wa_link!}
                target="_blank"
                rel="noreferrer"
                onClick={() => mark.mutate({ campaignId, recipientId: r.id })}
              >
                <Button size="sm" variant="outline" className="h-7 gap-1 border-border text-[11px]">
                  <MessageCircle className="h-3 w-3" /> Open
                </Button>
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
