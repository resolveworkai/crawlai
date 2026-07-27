/** Authored by: Mohit Singh */
//
// Real-Postgres integration test for the marketing surface — recipient preview/dedup, template
// CRUD, campaign create + WhatsApp mark-sent + vCard, suppression, and the public unsubscribe
// token flow. Requires DATABASE_URL at a live migrated Postgres + MESSAGING_ENCRYPTION_KEY for the
// credentials test. Run with: npm run test:integration.
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { pool } from "../../db/pool.js";
import { hashPassword } from "../../auth/password.js";
import { createUser } from "../../db/users.js";
import { assignRole } from "../../db/userRoles.js";
import { makeUnsubscribeToken } from "../../lib/unsubscribeToken.js";

const app = createApp();
const runId = randomUUID().slice(0, 8);
const password = "correct-horse-battery-staple";
const cleanupUserIds: string[] = [];
const cleanupCampaignIds: string[] = [];
const cleanupTemplateIds: string[] = [];
const cleanupSuppress: string[] = [];
const cleanupContactIds: string[] = [];

let operatorAgent: ReturnType<typeof request.agent>;
let viewerAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  // messagingCrypto reads this at call time — set it so credential save works in-process.
  process.env.MESSAGING_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

  const operator = await createUser({
    email: `mkt-op-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(operator.id, "operator");
  cleanupUserIds.push(operator.id);

  const viewer = await createUser({
    email: `mkt-viewer-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(viewer.id, "viewer");
  cleanupUserIds.push(viewer.id);

  operatorAgent = request.agent(app);
  await operatorAgent.post("/auth/login").send({ email: operator.email, password });
  viewerAgent = request.agent(app);
  await viewerAgent.post("/auth/login").send({ email: viewer.email, password });
});

afterAll(async () => {
  if (cleanupCampaignIds.length)
    await pool.query("DELETE FROM campaigns WHERE id = ANY($1)", [cleanupCampaignIds]);
  if (cleanupTemplateIds.length)
    await pool.query("DELETE FROM message_templates WHERE id = ANY($1)", [cleanupTemplateIds]);
  if (cleanupSuppress.length)
    await pool.query("DELETE FROM email_suppressions WHERE email = ANY($1)", [cleanupSuppress]);
  if (cleanupContactIds.length)
    await pool.query("DELETE FROM marketing_contacts WHERE id = ANY($1)", [cleanupContactIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [cleanupUserIds]);
  // email_credentials is a singleton row (id=1) mutated by the "email credentials" test below —
  // reset it to blank rather than deleting it (the app expects the row to always exist).
  await pool.query(
    `UPDATE email_credentials SET smtp_host=NULL, smtp_port=NULL, smtp_secure=TRUE, smtp_user=NULL,
       smtp_password_encrypted=NULL, from_name=NULL, from_email=NULL, reply_to=NULL,
       org_address=NULL, verified=FALSE, updated_at=now() WHERE id=1`,
  );
  await pool.end();
});

function csvBase64(): string {
  const csv =
    "Name,Category,Address,Phone,Email\n" +
    "Gym A,Gym,Delhi,+911111111111,a@x.com\n" +
    "Gym A dup,Gym,Delhi,+911111111111,a@x.com\n" + // same phone → deduped
    "Gym B,Gym,Mumbai,+912222222222,b@x.com\n";
  return Buffer.from(csv, "utf-8").toString("base64");
}

describe("POST /marketing/recipients/preview", () => {
  it("dedupes an uploaded file to unique businesses (401 for anon, works for viewer)", async () => {
    const anon = await request(app).post("/marketing/recipients/preview").send({});
    expect(anon.status).toBe(401);

    const res = await viewerAgent
      .post("/marketing/recipients/preview")
      .send({ upload: { filename: "x.csv", base64: csvBase64() } });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // the duplicate phone row collapsed
    expect(res.body.withPhone).toBe(2);
    expect(res.body.recipients[0]).toMatchObject({ businessName: "Gym A", businessType: "Gym", location: "Delhi" });
  });
});

describe("email credentials", () => {
  it("never returns the password; write requires operator; read exposes only public fields", async () => {
    const denied = await viewerAgent.put("/marketing/email-credentials").send({
      smtpHost: "smtp.x.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "u@x.com",
      smtpPassword: "p",
      fromName: "N",
      fromEmail: "u@x.com",
    });
    expect(denied.status).toBe(403);

    const put = await operatorAgent.put("/marketing/email-credentials").send({
      smtpHost: "smtp.x.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "u@x.com",
      smtpPassword: "super-secret",
      fromName: "Scout",
      fromEmail: "u@x.com",
      orgAddress: "1 St",
    });
    expect(put.status).toBe(200);

    const read = await operatorAgent.get("/marketing/email-credentials");
    expect(read.status).toBe(200);
    expect(read.body.credentials.smtpHost).toBe("smtp.x.com");
    expect(read.body.credentials.configured).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain("super-secret");
    expect(read.body.credentials).not.toHaveProperty("smtp_password_encrypted");
  });
});

describe("templates + campaign + whatsapp", () => {
  it("creates a whatsapp template, a campaign, marks a recipient sent, and downloads a vCard", async () => {
    const tpl = await operatorAgent
      .post("/marketing/templates")
      .send({ channel: "whatsapp", name: "Onboard", body: "Hi {business_name}!" });
    expect(tpl.status).toBe(201);
    cleanupTemplateIds.push(tpl.body.template.id);

    const campaign = await operatorAgent.post("/marketing/campaigns").send({
      channel: "whatsapp",
      templateId: tpl.body.template.id,
      body: "Hi {business_name}!",
      recipients: [
        { businessName: "Gym A", businessType: "Gym", location: "Delhi", phone: "+911111111111", email: null },
      ],
    });
    expect(campaign.status).toBe(201);
    const campaignId = campaign.body.campaign.id as string;
    cleanupCampaignIds.push(campaignId);

    const detail = await operatorAgent.get(`/marketing/campaigns/${campaignId}`);
    expect(detail.body.recipients).toHaveLength(1);
    expect(detail.body.recipients[0].wa_link).toContain("https://wa.me/911111111111");
    const rid = detail.body.recipients[0].id as string;

    const mark = await operatorAgent.post(`/marketing/campaigns/${campaignId}/recipients/${rid}/mark-sent`);
    expect(mark.status).toBe(200);
    expect(mark.body.recipient.status).toBe("sent");
    expect(mark.body.campaign.sent_count).toBe(1);

    const vcard = await operatorAgent.get(`/marketing/campaigns/${campaignId}/vcard`);
    expect(vcard.status).toBe(200);
    expect(vcard.headers["content-type"]).toContain("text/vcard");
    expect(vcard.text).toContain("FN:Gym A");

    // Binary xlsx — supertest doesn't buffer application/* bodies into .text/.body by default (the
    // actual workbook structure is validated by campaignExportService.test.ts); just confirm the
    // endpoint responds with the right headers.
    const report = await operatorAgent.get(`/marketing/campaigns/${campaignId}/export`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("spreadsheetml");
    expect(report.headers["content-disposition"]).toContain("campaign-report_whatsapp");
  });

  it("mark-failed records a failure instead of leaving the recipient stuck pending (used by the automation agent)", async () => {
    const campaign = await operatorAgent.post("/marketing/campaigns").send({
      channel: "whatsapp",
      body: "Hi {business_name}!",
      recipients: [
        { businessName: "Gym C", businessType: "Gym", location: "Pune", phone: "+913333333333", email: null },
      ],
    });
    expect(campaign.status).toBe(201);
    const campaignId = campaign.body.campaign.id as string;
    cleanupCampaignIds.push(campaignId);

    const detail = await operatorAgent.get(`/marketing/campaigns/${campaignId}`);
    const rid = detail.body.recipients[0].id as string;

    const fail = await operatorAgent
      .post(`/marketing/campaigns/${campaignId}/recipients/${rid}/mark-failed`)
      .send({ error: "chat did not load" });
    expect(fail.status).toBe(200);
    expect(fail.body.recipient.status).toBe("failed");
    expect(fail.body.recipient.error).toBe("chat did not load");
    expect(fail.body.campaign.failed_count).toBe(1);
  });
});

describe("contacts (manually-added, reusable)", () => {
  it("creates, normalizes phone/email, lists, and feeds into recipient preview via contactIds", async () => {
    const denied = await viewerAgent.post("/marketing/contacts").send({ businessName: "X" });
    expect(denied.status).toBe(403);

    const created = await operatorAgent.post("/marketing/contacts").send({
      businessName: "Hand-Added Gym",
      businessType: "Gym",
      location: "Jaipur",
      phone: "98765 43210", // bare Indian mobile — should normalize to +91...
      email: "OWNER@Gym.com", // should lowercase
    });
    expect(created.status).toBe(201);
    const contactId = created.body.contact.id as string;
    cleanupContactIds.push(contactId);
    expect(created.body.contact.phone).toBe("+919876543210");
    expect(created.body.contact.email).toBe("owner@gym.com");

    const list = await operatorAgent.get("/marketing/contacts");
    expect(list.status).toBe(200);
    expect(list.body.contacts.some((c: { id: string }) => c.id === contactId)).toBe(true);

    const preview = await operatorAgent
      .post("/marketing/recipients/preview")
      .send({ contactIds: [contactId] });
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(1);
    expect(preview.body.recipients[0]).toMatchObject({ businessName: "Hand-Added Gym", businessType: "Gym" });
  });

  it("updates and deletes a contact", async () => {
    const created = await operatorAgent.post("/marketing/contacts").send({ businessName: "Temp Co" });
    const contactId = created.body.contact.id as string;

    const updated = await operatorAgent
      .patch(`/marketing/contacts/${contactId}`)
      .send({ businessName: "Renamed Co", location: "Goa" });
    expect(updated.status).toBe(200);
    expect(updated.body.contact.business_name).toBe("Renamed Co");
    expect(updated.body.contact.location).toBe("Goa");

    const del = await operatorAgent.delete(`/marketing/contacts/${contactId}`);
    expect(del.status).toBe(204);

    const missing = await operatorAgent.delete(`/marketing/contacts/${contactId}`);
    expect(missing.status).toBe(404);
  });
});

describe("suppression + public unsubscribe", () => {
  it("adds via the public token flow and rejects a forged token", async () => {
    const email = `unsub-${runId}@x.com`;
    cleanupSuppress.push(email);

    const forged = await request(app).get("/unsubscribe").query({ email, token: "deadbeef" });
    expect(forged.status).toBe(400);

    const ok = await request(app)
      .get("/unsubscribe")
      .query({ email, token: makeUnsubscribeToken(email) });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("Unsubscribed");

    const { rowCount } = await pool.query("SELECT 1 FROM email_suppressions WHERE email = $1", [email]);
    expect(rowCount).toBe(1);
  });
});
