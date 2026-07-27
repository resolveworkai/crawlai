/** Authored by: Mohit Singh */
//
// Renders an email with renderEmail() (pure — no network) and also feeds it through nodemailer's
// jsonTransport to prove nodemailer accepts the shape (placeholders, CID inline image, compliance
// footer + List-Unsubscribe header) without ever hitting a real SMTP server.
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { renderEmail } from "./emailService.js";
import type { SmtpConfig } from "../db/messagingCredentials.js";
import type { Recipient } from "../lib/recipientParse.js";

const smtp: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "me@example.com",
  password: "secret",
  fromName: "Scout",
  fromEmail: "me@example.com",
  replyTo: "reply@example.com",
  orgAddress: "1 Test St, Dubai",
};

const rec: Recipient = {
  businessName: "Flow Fitness",
  businessType: "Gym",
  location: "Al Nahda, Dubai",
  phone: "+971585325771",
  email: "owner@flow.com",
};

describe("renderEmail", () => {
  it("substitutes placeholders, appends the unsubscribe footer, and wires CID images", () => {
    const images = [
      {
        cid: "logo",
        filename: "logo.png",
        mime: "image/png",
        bytes: Buffer.from([1, 2, 3]),
        isInline: true,
      },
    ];
    const r = renderEmail(
      smtp,
      rec,
      "Hi {business_name}",
      '<p>Grow {business_name} in {city}.</p><img src="cid:logo"/>',
      images,
    );
    expect(r.to).toBe("owner@flow.com");
    expect(r.subject).toBe("Hi Flow Fitness");
    expect(r.html).toContain("Grow Flow Fitness in Al Nahda.");
    expect(r.html).toContain('src="cid:logo"');
    expect(r.html).toContain("Unsubscribe");
    expect(r.html).toContain("1 Test St, Dubai");
    expect(r.headers["List-Unsubscribe"]).toMatch(/^<https?:.*\/unsubscribe\?email=owner%40flow\.com&token=/);
    expect(r.replyTo).toBe("reply@example.com");
    expect(r.attachments[0]).toMatchObject({
      cid: "logo",
      filename: "logo.png",
      contentDisposition: "inline",
    });
  });

  it("wires a non-inline image as a plain attachment (no cid, Content-Disposition: attachment)", () => {
    const images = [
      {
        cid: "brochure",
        filename: "brochure.pdf",
        mime: "application/pdf",
        bytes: Buffer.from([1, 2, 3]),
        isInline: false,
      },
    ];
    const r = renderEmail(smtp, rec, "Hi {business_name}", "<p>See attached.</p>", images);
    expect(r.attachments[0]).toMatchObject({
      filename: "brochure.pdf",
      contentType: "application/pdf",
      contentDisposition: "attachment",
    });
    expect(r.attachments[0]!.cid).toBeUndefined();
  });

  it("produces a message nodemailer's jsonTransport accepts", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const rendered = renderEmail(smtp, rec, "Hi {business_name}", "<p>Hello</p>", []);
    const info = (await transport.sendMail(rendered)) as unknown as { message: string };
    const message = JSON.parse(info.message) as { subject: string; to: { address: string }[] };
    expect(message.subject).toBe("Hi Flow Fitness");
    expect(message.to[0]!.address).toBe("owner@flow.com");
  });
});
