/** Authored by: Mohit Singh */
//
// Drives the operator's OWN, already-logged-in WhatsApp Web session via a persistent Playwright
// browser profile. Deliberately headed (visible), never headless — the operator can watch it work
// and close the window to hard-stop at any point; a persistent profile means the QR-code login is a
// one-time cost. This is the one piece of the marketing tool that actually automates WhatsApp — see
// README.md for the ToS/ban-risk disclaimer before running it.
//
// WhatsApp Web's DOM/selectors change over time (it's not a stable API) — if sends start failing
// with a composer-not-found timeout, the selectors below are the first thing to re-check against
// the live site.
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), ".whatsapp-sender-profile");

export interface WaSessionOptions {
  profileDir?: string;
  headless?: boolean; // only ever set true in tests that never reach here — real runs stay visible
}

export class WaSession {
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  constructor(private readonly options: WaSessionOptions = {}) {}

  /** Opens (or reuses) the persistent browser profile and waits for a logged-in WhatsApp Web
   * session — on a fresh profile this blocks on the operator scanning the QR code. */
  async open(): Promise<void> {
    const profileDir = this.options.profileDir ?? DEFAULT_PROFILE_DIR;
    fs.mkdirSync(profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: this.options.headless ?? false,
      viewport: { width: 1280, height: 900 },
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });
    await this.page.waitForSelector('div[aria-label="Chat list"], canvas[aria-label]', {
      timeout: 120_000,
    });
  }

  /** Opens a chat with `phoneDigits` (E.164 digits, no leading +) pre-filled with `text` and sends
   * it. Optionally attaches a local file first (image/PDF/etc — the one capability click-to-chat
   * links can never offer, since wa.me only supports pre-filled text). Throws if the chat/composer
   * never loads (e.g. the number isn't on WhatsApp) — the caller should mark that recipient failed
   * rather than retry indefinitely. */
  async sendTo(phoneDigits: string, text: string, mediaPath?: string): Promise<void> {
    if (!this.page) throw new Error("Session not open — call open() first");
    const url = `https://web.whatsapp.com/send?phone=${phoneDigits}&text=${encodeURIComponent(text)}`;
    await this.page.goto(url, { waitUntil: "domcontentloaded" });

    const composer = this.page.locator('[contenteditable="true"][data-tab]').last();
    await composer.waitFor({ timeout: 30_000 });

    if (mediaPath) {
      await this.page.locator('[data-icon="attach-menu-plus"], [data-icon="clip"]').first().click();
      const fileInput = this.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(mediaPath);
      await this.page.waitForTimeout(1500); // let the media preview render before sending
    }

    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(1000); // give the send a moment to register before navigating away
  }

  async close(): Promise<void> {
    await this.context?.close();
  }
}
