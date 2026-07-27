/** Authored by: Mohit Singh */
//
// Idempotent local-dev seed: one admin user + a couple of sample dynamic_fields.
// crawl_settings' singleton row already seeds itself via its migration — nothing to do here.
// Run with: npm run seed (backend/api), against a real DATABASE_URL.
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
import { createUser, findUserByEmail } from "../db/users.js";
import { assignRole } from "../db/userRoles.js";
import { createDynamicField, listDynamicFields } from "../db/dynamicFields.js";
import { createTemplate, listTemplates, updateTemplate } from "../db/messageTemplates.js";
import { logger } from "../logger.js";

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@business-scout.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "change-me-dev-only";
const BCRYPT_ROUNDS = 10;

async function seedAdminAccount(email: string, password: string, fullName: string): Promise<void> {
  const existing = await findUserByEmail(email);
  if (existing) {
    logger.info({ email }, "seed: admin user already exists, skipping create");
    await assignRole(existing.id, "admin");
    return;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await createUser({ email, passwordHash, fullName });
  await assignRole(user.id, "admin");
  logger.info({ email }, "seed: created admin user");
}

async function seedAdminUser(): Promise<void> {
  await seedAdminAccount(ADMIN_EMAIL, ADMIN_PASSWORD, "Admin");
  if (!process.env.SEED_ADMIN_PASSWORD) {
    logger.warn(
      "seed: using the default dev-only admin password — set SEED_ADMIN_PASSWORD for anything beyond local dev",
    );
  }

  // Second, fixed-credential dev admin (requested directly, not env-configurable) — local/dev
  // only, guarded on NODE_ENV so a mistaken `npm run seed` against a real deployment can never
  // create an account with a known, hardcoded password.
  if (process.env.NODE_ENV !== "production") {
    await seedAdminAccount("admin@admin.com", "Test@123", "Admin");
  }
}

async function seedDynamicFields(): Promise<void> {
  const existing = await listDynamicFields();
  const existingKeys = new Set(existing.map((f) => f.key));

  const samples = [
    {
      key: "accepts_walk_ins",
      label: "Accepts Walk-Ins",
      prompt: "Does this business accept walk-in customers without an appointment?",
      fieldType: "boolean" as const,
    },
    {
      key: "years_in_business",
      label: "Years in Business",
      prompt:
        "How many years has this business been operating? Return an integer, or null if unknown.",
      fieldType: "number" as const,
    },
  ];

  for (const sample of samples) {
    if (existingKeys.has(sample.key)) {
      logger.info({ key: sample.key }, "seed: dynamic field already exists, skipping");
      continue;
    }
    await createDynamicField(sample);
    logger.info({ key: sample.key }, "seed: created dynamic field");
  }
}

// Curated starter templates for the Marketing composer — one generic + one or more per business
// type (gym/library/coaching), for both channels. Every message links https://portal.c7corp.com
// (the real product being pitched) as a plain, standalone URL — WhatsApp and most email clients
// auto-generate a link-preview card from a bare URL, but not from text wrapped in custom anchor
// text like "click here", so the visible link text is always the literal URL itself. Copy avoids
// unverifiable claims (no "100% conversion"-style guarantees, which read as spam and erode trust in
// cold outreach) but is specific about real Portal features. WhatsApp bodies end with "Reply STOP
// to opt out" (WhatsApp has no header-based unsubscribe like email does). See md/MARKETING.md.
const PORTAL_URL = "https://portal.c7corp.com";

interface SeedTemplate {
  channel: "whatsapp" | "email";
  name: string;
  subject: string | null;
  body: string;
  businessType: string | null;
}

const MARKETING_TEMPLATES: SeedTemplate[] = [
  {
    channel: "whatsapp",
    name: "Generic — Online booking pitch",
    subject: null,
    businessType: null,
    body:
      "Hi {business_name}! I came across your {business_type} in {city} and wanted to reach out. " +
      "Portal helps local businesses get discovered online, take bookings without back-and-forth " +
      "calls, and send automatic reminders so fewer people miss their slot. It's free to get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Generic — Online booking pitch",
    subject: "Get {business_name} taking bookings online — free to list",
    businessType: null,
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your {business_type} in {location} while researching local businesses.</p>" +
      "<p>A lot of businesses like yours still take bookings over the phone or in person — which means " +
      "missed calls, double-bookings, and no-shows nobody hears about until the slot is already gone.</p>" +
      "<p>Portal gives businesses like {business_name}:</p>" +
      "<ul><li>Bookings online, any time, without a phone call</li>" +
      "<li>Automatic reminders to cut down no-shows</li>" +
      "<li>A public listing so new customers searching nearby can find you</li></ul>" +
      "<p>It's free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Happy to walk you through it if you're interested — just reply to this email.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Gym — Reduce no-shows",
    subject: null,
    businessType: "Gym",
    body:
      "Hi {business_name}! I found your gym in {city} while researching fitness businesses in the area. " +
      "A lot of gyms lose members to missed renewals and no-shows they never hear about in time. " +
      "Portal gives you online class bookings, membership tracking, and automatic reminders — " +
      "all in one place, free to get started.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Gym — Reduce no-shows",
    subject: "Fewer no-shows, more bookings for {business_name}",
    businessType: "Gym",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your gym in {location} while researching fitness businesses nearby.</p>" +
      "<p>Membership tracking and class bookings by phone or WhatsApp get messy fast — missed renewals, " +
      "double-booked classes, and no-shows that eat into your trainers' time.</p>" +
      "<p>Portal gives gyms like {business_name}:</p>" +
      "<ul><li>Online class &amp; session bookings, with live capacity</li>" +
      "<li>Membership tracking and renewal reminders</li>" +
      "<li>Automatic booking reminders to cut down no-shows</li>" +
      "<li>A public listing so new members can find and book you</li></ul>" +
      "<p>Free to get started — take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email and I'll walk you through it.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — Seat bookings",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Came across your library/study space in {city}. Portal lets spaces like " +
      "yours take seat bookings online (no more phone-tag for slots) and send automatic reminders so " +
      "seats don't sit empty from no-shows. Free to get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Seat bookings",
    subject: "Simple seat bookings for {business_name}",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>Managing seat availability over the phone or a walk-in sign-up sheet means empty seats when " +
      "someone doesn't show, and no easy way for new students to find you.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>Online seat booking by time slot, with live availability</li>" +
      "<li>Automatic reminders to cut down no-shows</li>" +
      "<li>A public listing so students searching nearby can find and book you</li></ul>" +
      "<p>Free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email if you'd like a quick walkthrough.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — Daily/weekly/monthly passes",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Noticed your study space in {city} — quick one for you. Portal lets " +
      "members buy daily, weekly, or monthly passes online and pick their own seat/time slot, so you " +
      "get paid upfront instead of chasing walk-ins, and members get reminders so they actually show " +
      "up. Free to get listed, takes minutes to set up.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Daily/weekly/monthly passes",
    subject: "Sell daily/weekly/monthly passes online — {business_name}",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces " +
      "nearby, and wanted to flag something that's worked well for spaces like yours.</p>" +
      "<p>Instead of collecting cash at the door or tracking regulars on paper, Portal lets you sell:</p>" +
      "<ul><li>Daily, weekly, and monthly seat passes — paid online, upfront</li>" +
      "<li>Time-slot bookings with live seat availability, so two people never show up for the same seat</li>" +
      "<li>Automatic WhatsApp &amp; email reminders, so paid slots don't go empty</li>" +
      "<li>A public listing so students searching nearby can find and book {business_name} directly</li></ul>" +
      "<p>It's free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Happy to walk you through setup — just reply to this email.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Coaching — Fill your sessions",
    subject: null,
    businessType: "Coaching",
    body:
      "Hi {business_name}! Spotted your coaching business in {city} and wanted to reach out. Portal " +
      "helps coaches manage session bookings online, send automatic reminders to cut down no-shows, " +
      "and get discovered by new students searching nearby — free to get started.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Coaching — Fill your sessions",
    subject: "Fill your sessions — online booking for {business_name}",
    businessType: "Coaching",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your coaching business in {location} while researching local coaches.</p>" +
      "<p>Booking sessions over calls or messages takes time, and a missed reminder means an empty slot " +
      "you can't get back.</p>" +
      "<p>Portal gives coaches like {business_name}:</p>" +
      "<ul><li>Online session bookings students can make themselves</li>" +
      "<li>Automatic reminders to cut down no-shows</li>" +
      "<li>A public listing so new students searching nearby can find and book you</li></ul>" +
      "<p>Free to get started. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email and I'll send more details.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
];

async function seedMarketingTemplates(): Promise<void> {
  // Keyed on (channel, name) — the WhatsApp and Email variant of each pitch intentionally share a
  // display name, so a name-only key would wrongly skip one of them. Upserts (not insert-only) so
  // copy edits made here actually take effect on any environment where seed is re-run, rather than
  // being silently stuck at whatever content first got inserted.
  const existing = await listTemplates();
  const existingByKey = new Map(existing.map((t) => [`${t.channel}:${t.name}`, t]));

  for (const tpl of MARKETING_TEMPLATES) {
    const key = `${tpl.channel}:${tpl.name}`;
    const found = existingByKey.get(key);
    if (found) {
      if (
        found.subject !== tpl.subject ||
        found.body !== tpl.body ||
        found.business_type !== tpl.businessType
      ) {
        await updateTemplate(found.id, {
          subject: tpl.subject,
          body: tpl.body,
          businessType: tpl.businessType,
        });
        logger.info({ name: tpl.name, channel: tpl.channel }, "seed: updated marketing template content");
      } else {
        logger.info({ name: tpl.name, channel: tpl.channel }, "seed: marketing template already up to date");
      }
      continue;
    }
    await createTemplate({
      channel: tpl.channel,
      name: tpl.name,
      subject: tpl.subject,
      body: tpl.body,
      businessType: tpl.businessType,
      createdBy: null,
    });
    logger.info({ name: tpl.name, channel: tpl.channel }, "seed: created marketing template");
  }
}

async function main(): Promise<void> {
  await seedAdminUser();
  await seedDynamicFields();
  await seedMarketingTemplates();
  logger.info("seed: complete");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed: failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
