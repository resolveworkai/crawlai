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
  campaignVcardUrl,
  useCampaign,
  useCreateCampaign,
  useEmailCredentials,
  useMarkRecipientSent,
  usePreviewRecipients,
  useSaveEmailCredentials,
  useSendCampaign,
  useTemplates,
  useTestEmail,
  type RecipientSource,
} from "@/hooks/useMarketing";
import type { MarketingRecipient, MessageChannel } from "@/types/api";
import { toast } from "sonner";
import { AlertTriangle, Contact, Download, Mail, MessageCircle, Send, Upload } from "lucide-react";

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
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);

  const preview = recipients[0];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RecipientStep channel={channel} onLoaded={setRecipients} recipients={recipients} />
      <MessageStep
        channel={channel}
        subject={subject}
        body={body}
        setSubject={setSubject}
        setBody={setBody}
        previewRecipient={preview}
      />
      {channel === "email" && <EmailCredsCard />}
      <SendStep
        channel={channel}
        recipients={recipients}
        subject={subject}
        body={body}
        campaignId={campaignId}
        setCampaignId={setCampaignId}
      />
    </div>
  );
}

// --- Step 1: recipients ---
function RecipientStep({
  channel,
  recipients,
  onLoaded,
}: {
  channel: MessageChannel;
  recipients: MarketingRecipient[];
  onLoaded: (r: MarketingRecipient[]) => void;
}) {
  const { data: ocrJobs = [] } = useOcrJobs();
  const readyJobs = ocrJobs.filter((j) => j.status === "ready");
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);
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
    if (!source.upload && !source.ocrJobIds) {
      toast.error("Upload a file or pick an OCR job first");
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

        <Button size="sm" disabled={previewMut.isPending} onClick={load} className="gap-1.5">
          <Contact className="h-3.5 w-3.5" /> Load recipients
        </Button>
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

// --- Step 2: message ---
function MessageStep({
  channel,
  subject,
  body,
  setSubject,
  setBody,
  previewRecipient,
}: {
  channel: MessageChannel;
  subject: string;
  body: string;
  setSubject: (v: string) => void;
  setBody: (v: string) => void;
  previewRecipient: MarketingRecipient | undefined;
}) {
  const { data: templates = [] } = useTemplates(channel);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insert(token: string) {
    const el = bodyRef.current;
    const t = `{${token}}`;
    if (!el) return setBody(body + t);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setBody(body.slice(0, start) + t + body.slice(end));
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
            defaultValue=""
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) {
                setBody(t.body);
                if (t.subject) setSubject(t.subject);
              }
            }}
          >
            <option value="">Load a saved template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
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
      </div>
    </Card>
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
  campaignId,
  setCampaignId,
}: {
  channel: MessageChannel;
  recipients: MarketingRecipient[];
  subject: string;
  body: string;
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
      { channel, subject: channel === "email" ? subject : null, body, recipients },
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
              <a href={campaignVcardUrl(campaignId)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                  <Download className="h-3.5 w-3.5" /> Download vCard (save contacts by name)
                </Button>
              </a>
              <p className="text-[11px] text-muted-foreground">
                Click each business to open WhatsApp with the message pre-filled, then press Send.
              </p>
              <WhatsAppRecipientList campaignId={campaignId} />
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
