/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fileUrl } from "@/lib/api-client";
import type {
  Campaign,
  CampaignRecipient,
  CampaignStatus,
  EmailSuppression,
  MarketingContact,
  MarketingRecipient,
  MessageChannel,
  MessageTemplate,
  MessageTemplateImage,
  PublicEmailCredentials,
  RecipientPreview,
} from "@/types/api";

export const marketingKeys = {
  all: ["marketing"] as const,
  credentials: () => [...marketingKeys.all, "email-credentials"] as const,
  templates: (channel?: MessageChannel) =>
    [...marketingKeys.all, "templates", channel ?? "all"] as const,
  templateImages: (templateId: string) =>
    [...marketingKeys.all, "template-images", templateId] as const,
  campaigns: () => [...marketingKeys.all, "campaigns"] as const,
  campaign: (id: string) => [...marketingKeys.all, "campaign", id] as const,
  suppressions: () => [...marketingKeys.all, "suppressions"] as const,
  contacts: () => [...marketingKeys.all, "contacts"] as const,
};

const ACTIVE_CAMPAIGN: ReadonlySet<CampaignStatus> = new Set(["sending"]);

// --- recipients ---
export interface RecipientSource {
  upload?: { filename: string; base64: string };
  ocrJobIds?: string[];
  contactIds?: string[];
}
export function usePreviewRecipients() {
  return useMutation({
    mutationFn: (source: RecipientSource) =>
      api.post<RecipientPreview>("/marketing/recipients/preview", source),
  });
}

// --- email credentials ---
export function useEmailCredentials() {
  return useQuery({
    queryKey: marketingKeys.credentials(),
    queryFn: () =>
      api.get<{ credentials: PublicEmailCredentials; encryptionAvailable: boolean }>(
        "/marketing/email-credentials",
      ),
  });
}
export interface SaveCredentialsInput {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  orgAddress?: string;
}
export function useSaveEmailCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCredentialsInput) =>
      api.put<{ credentials: PublicEmailCredentials }>("/marketing/email-credentials", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.credentials() }),
  });
}
export function useTestEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) => api.post<{ ok: true }>("/marketing/email-credentials/test", { to }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.credentials() }),
  });
}

// --- templates ---
export function useTemplates(channel?: MessageChannel) {
  return useQuery({
    queryKey: marketingKeys.templates(channel),
    queryFn: async () =>
      (
        await api.get<{ templates: MessageTemplate[] }>(
          channel ? `/marketing/templates?channel=${channel}` : "/marketing/templates",
        )
      ).templates,
  });
}
export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      channel: MessageChannel;
      name: string;
      subject?: string | null;
      body: string;
      businessType?: string | null;
    }) => api.post<{ template: MessageTemplate }>("/marketing/templates", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.all }),
  });
}
export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/marketing/templates/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.all }),
  });
}
export function useTemplateImages(templateId: string | undefined) {
  return useQuery({
    queryKey: marketingKeys.templateImages(templateId ?? ""),
    queryFn: async () =>
      (
        await api.get<{ images: MessageTemplateImage[] }>(
          `/marketing/templates/${templateId}/images`,
        )
      ).images,
    enabled: templateId !== undefined,
  });
}
export function useAddTemplateImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      templateId: string;
      cid: string;
      filename: string;
      mime: string;
      base64: string;
      isInline: boolean;
    }) =>
      api.post<{ image: MessageTemplateImage }>(`/marketing/templates/${input.templateId}/images`, {
        cid: input.cid,
        filename: input.filename,
        mime: input.mime,
        base64: input.base64,
        isInline: input.isInline,
      }),
    onSuccess: (_d, input) =>
      void qc.invalidateQueries({ queryKey: marketingKeys.templateImages(input.templateId) }),
  });
}

// --- contacts (manually-added, reusable) ---
export function useContacts() {
  return useQuery({
    queryKey: marketingKeys.contacts(),
    queryFn: async () =>
      (await api.get<{ contacts: MarketingContact[] }>("/marketing/contacts")).contacts,
  });
}
export interface CreateContactInput {
  businessName: string;
  businessType?: string | null;
  location?: string | null;
  phone?: string | null;
  email?: string | null;
}
export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) =>
      api.post<{ contact: MarketingContact }>("/marketing/contacts", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.contacts() }),
  });
}
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/marketing/contacts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.contacts() }),
  });
}

// --- campaigns ---
export interface CreateCampaignInput {
  channel: MessageChannel;
  templateId?: string | null;
  subject?: string | null;
  body: string;
  recipients: MarketingRecipient[];
}
export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCampaignInput) =>
      api.post<{ campaign: Campaign }>("/marketing/campaigns", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: marketingKeys.campaigns() }),
  });
}
export function useCampaigns() {
  return useQuery({
    queryKey: marketingKeys.campaigns(),
    queryFn: async () =>
      (await api.get<{ campaigns: Campaign[] }>("/marketing/campaigns")).campaigns,
  });
}
/** `pollWhileActive` forces the 2s poll even when the campaign row itself isn't 'sending' — a
 * WhatsApp campaign driven by the local agent stays 'draft' server-side (progress is recorded
 * per-recipient via mark-sent/mark-failed, never on the campaign), so without this the live send
 * log would sit frozen while the agent is actually working. */
export function useCampaign(id: string | undefined, pollWhileActive = false) {
  return useQuery({
    queryKey: marketingKeys.campaign(id ?? ""),
    queryFn: () =>
      api.get<{ campaign: Campaign; recipients: CampaignRecipient[] }>(
        `/marketing/campaigns/${id}`,
      ),
    enabled: id !== undefined,
    refetchInterval: (q) =>
      pollWhileActive || (q.state.data && ACTIVE_CAMPAIGN.has(q.state.data.campaign.status))
        ? 2_000
        : false,
  });
}
export function useSendCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/marketing/campaigns/${id}/send`),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: marketingKeys.campaign(id) });
      void qc.invalidateQueries({ queryKey: marketingKeys.campaigns() });
    },
  });
}
export function useMarkRecipientSent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { campaignId: string; recipientId: string }) =>
      api.post<{ recipient: CampaignRecipient; campaign: Campaign }>(
        `/marketing/campaigns/${input.campaignId}/recipients/${input.recipientId}/mark-sent`,
      ),
    onSuccess: (_d, input) =>
      void qc.invalidateQueries({ queryKey: marketingKeys.campaign(input.campaignId) }),
  });
}
export function campaignVcardUrl(id: string): string {
  return fileUrl(`/marketing/campaigns/${id}/vcard`);
}
export function campaignExportUrl(id: string): string {
  return fileUrl(`/marketing/campaigns/${id}/export`);
}

// --- suppressions ---
export function useSuppressions() {
  return useQuery({
    queryKey: marketingKeys.suppressions(),
    queryFn: async () =>
      (await api.get<{ suppressions: EmailSuppression[] }>("/marketing/suppressions")).suppressions,
  });
}
