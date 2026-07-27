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
    name: "Library — Stop double-booked seats",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Quick one about your study space in {city}. If seats get booked over the " +
      "phone or on paper, it's easy for two students to end up promised the same seat — awkward at " +
      "the door. Portal shows live seat availability and locks a seat the moment it's booked, even " +
      "for full-day slots (so a morning booking can't quietly clash with an afternoon one). Free to " +
      "get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Stop double-booked seats",
    subject: "Stop double-booked seats at {business_name}",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>When seats are booked by phone or written down on paper, it's easy for two students to end up " +
      "promised the same seat — an awkward conversation at the door, and a bad first impression for " +
      "someone new.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>Live seat availability, so a seat is locked the moment it's booked</li>" +
      "<li>Safe full-day bookings — morning and afternoon slots are reserved together, so they can't silently conflict</li>" +
      "<li>A public listing so new students searching nearby can find and book you</li></ul>" +
      "<p>Free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email if you'd like a quick walkthrough.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — Get found by new students",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Came across your study space in {city}. If most of your students find you " +
      "through word of mouth, you're likely missing the ones searching online right now. Portal gives " +
      "you a public listing with real reviews, so students searching nearby can find {business_name} " +
      "and book directly. Free to get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Get found by new students",
    subject: "Get {business_name} found by students searching nearby",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>If most of your students come through word of mouth, you're likely missing everyone who's " +
      "searching online right now for a place to study near them.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>A public listing with real reviews, so new students can find and trust you</li>" +
      "<li>Online booking, so a search turns straight into a booked seat</li>" +
      "<li>Automatic reminders to cut down no-shows</li></ul>" +
      "<p>Free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email if you'd like a quick walkthrough.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — Stop chasing renewals",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Noticed your study space in {city}. Tracking which member's pass is about " +
      "to expire is easy to lose track of on paper — and a forgotten renewal is revenue that just " +
      "quietly disappears. Portal sends automatic reminders before a pass expires, so members renew " +
      "instead of drifting away unnoticed. Free to get started.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Stop chasing renewals",
    subject: "Stop losing renewals at {business_name}",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>Tracking which member's pass is about to expire is easy to lose track of on paper — and a " +
      "renewal nobody followed up on is revenue that just quietly disappears.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>Automatic reminders before a pass expires, so members renew instead of drifting away</li>" +
      "<li>Daily, weekly, and monthly passes sold online, paid upfront</li>" +
      "<li>A dashboard showing exactly who's active and who's about to lapse</li></ul>" +
      "<p>Free to get started. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email and I'll send more details.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — See your busiest hours",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Spotted your study space in {city}. Without an easy way to see which hours " +
      "are busiest or what you're actually making each month, it's hard to plan staffing or pricing. " +
      "Portal gives you a dashboard showing bookings, revenue, and member trends at a glance. Free to " +
      "get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — See your busiest hours",
    subject: "See {business_name}'s busiest hours and real revenue",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>Without an easy way to see which hours are actually busiest or what you're making month to " +
      "month, it's hard to plan staffing, pricing, or when to open extra seats.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>A dashboard showing bookings, revenue, and member trends at a glance</li>" +
      "<li>Online seat booking by time slot, so demand is visible in real time</li>" +
      "<li>A public listing so new students searching nearby can find and book you</li></ul>" +
      "<p>Free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email if you'd like a quick walkthrough.</p>" +
      "<p>Best,<br/>The Team</p>",
  },
  {
    channel: "whatsapp",
    name: "Library — Cut down walk-in queues",
    subject: null,
    businessType: "Library",
    body:
      "Hi {business_name}! Came across your study space in {city}. A line at the desk to check seat " +
      "availability or pay costs you time, especially during exam season. Portal lets students check " +
      "live availability and book/pay from their phone before they even arrive. Free to get listed.\n\n" +
      PORTAL_URL +
      "\n\nReply STOP to opt out.",
  },
  {
    channel: "email",
    name: "Library — Cut down walk-in queues",
    subject: "Cut the front-desk queue at {business_name}",
    businessType: "Library",
    body:
      "<p>Hi {business_name} team,</p>" +
      "<p>I came across your study space in {location} while researching libraries and study spaces nearby.</p>" +
      "<p>A line at the desk just to check seat availability or pay costs everyone time — especially " +
      "during exam season when every seat matters.</p>" +
      "<p>Portal gives spaces like {business_name}:</p>" +
      "<ul><li>Live seat availability and booking students can check from their phone before they arrive</li>" +
      "<li>Online payment, so there's nothing to handle at the desk</li>" +
      "<li>Automatic reminders to cut down no-shows</li></ul>" +
      "<p>Free to get listed. Take a look:</p>" +
      `<p><a href="${PORTAL_URL}">${PORTAL_URL}</a></p>` +
      "<p>Reply to this email and I'll send more details.</p>" +
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
