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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), ".whatsapp-sender-profile");

/** Kills any leftover browser process still holding OUR profile directory, before we try to launch.
 *
 * Why this is necessary: Chromium allows exactly one process per user-data-dir. If a previous run
 * was killed abruptly (Ctrl+C, crash, closed window), a zombie can keep the directory locked. The
 * next launch then prints "Opening in existing browser session", hands off to the zombie, and exits
 * immediately — Playwright loses its connection and the operator is left staring at a dead
 * about:blank window with no error. Clearing first makes that unreproducible.
 *
 * SAFETY: matches on the absolute profile path in the process command line, which only ever appears
 * in browsers WE launched (`--user-data-dir=<profileDir>`). The operator's own Chrome/Edge uses a
 * completely different profile and is never touched. Best-effort — a failure here is not fatal,
 * we just proceed and let the launch surface any real problem. */
function killOrphanedBrowsers(profileDir: string): boolean {
  // Fast path: Chromium only leaves `lockfile` behind while a process holds the profile. No
  // lockfile ⇒ nothing to kill ⇒ skip spawning a shell entirely. Worth the check because
  // `execFileSync("powershell", …)` costs 3-5s on Windows and blocks the event loop, which is
  // dead time the operator spends staring at an about:blank window on every single run.
  if (!fs.existsSync(path.join(profileDir, "lockfile"))) return false;

  try {
    if (process.platform === "win32") {
      // .Contains() (not -like) so backslashes/brackets in the path aren't treated as wildcards.
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name like '%chrome%'\" | " +
            "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WA_PROFILE_DIR) } | " +
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        ],
        { env: { ...process.env, WA_PROFILE_DIR: profileDir }, stdio: "ignore", timeout: 20_000 },
      );
    } else {
      // Non-zero exit just means "nothing matched" — harmless.
      execFileSync("pkill", ["-f", "--", profileDir], { stdio: "ignore", timeout: 20_000 });
    }
  } catch {
    // No matching process, or the tool isn't available — either way, carry on and launch.
  }
  return true;
}

export interface WaSessionOptions {
  profileDir?: string;
  headless?: boolean; // only ever set true in tests that never reach here — real runs stay visible
}

export class WaSession {
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  constructor(private readonly options: WaSessionOptions = {}) {}

  /** Opens (or reuses) the persistent browser profile and waits for a genuinely LOGGED-IN WhatsApp
   * Web session (the chat list) — never merely "the page rendered".
   *
   * This distinction is the whole ballgame: an earlier version waited for
   * `'div[aria-label="Chat list"], canvas[aria-label]'`, which also matched the QR-code canvas. A
   * QR screen therefore counted as "ready", the caller immediately navigated to the send URL, and
   * the scan was abandoned half-finished — so login never completed, nothing valid was persisted,
   * and every subsequent run showed a fresh QR code. Wait for the chat list ONLY; if a QR is up,
   * say so and give the operator real time to scan it.
   *
   * Two timeouts because the two cases are nothing alike: an already-persisted session resolves in
   * seconds (LOGIN_TIMEOUT_MS, short — fails fast on a broken start), while a first-time QR scan
   * needs a human with a phone (QR_TIMEOUT_MS, generous). */
  async open(): Promise<void> {
    const loginTimeoutMs = Number(process.env.LOGIN_TIMEOUT_MS ?? 40_000);
    const qrTimeoutMs = Number(process.env.QR_TIMEOUT_MS ?? 180_000);
    const profileDir = this.options.profileDir ?? DEFAULT_PROFILE_DIR;
    fs.mkdirSync(profileDir, { recursive: true });

    // Clear any zombie holding this profile — one makes the launch below fail in a confusing,
    // silent way (see killOrphanedBrowsers). Only pay the settle delay when we actually killed
    // something; on the normal path this costs nothing.
    if (killOrphanedBrowsers(profileDir)) {
      console.log("[wa] cleared a leftover browser holding the profile…");
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Chromium always opens on about:blank and only navigates once it's up; with a warm profile
    // that startup is several seconds of apparently-idle window. Say so, or it reads as a hang.
    console.log("[wa] starting browser (opens on about:blank for a few seconds)…");
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: this.options.headless ?? false,
      viewport: { width: 1280, height: 900 },
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.bringToFront();
    // `commit` (navigation started) rather than `domcontentloaded` — WhatsApp Web is a heavy SPA
    // whose DOMContentLoaded can stall well past a minute on a cold profile, which looks exactly
    // like a hang. We wait for the real readiness signal (the chat list) immediately below anyway,
    // so committing the navigation is the only thing this call needs to guarantee.
    console.log("[wa] opening web.whatsapp.com…");
    await this.page.goto("https://web.whatsapp.com", { waitUntil: "commit", timeout: 60_000 });

    // WhatsApp Web's DOM changes over time — match on several known logged-in markers so a single
    // renamed attribute doesn't break the whole login detection.
    const chatList = this.page
      .locator('[aria-label="Chat list"], [data-testid="chat-list"], #pane-side')
      .first();
    const qrCode = this.page.locator('canvas[aria-label], [data-testid="qrcode"]').first();

    // Fast path — session already persisted from a previous run.
    try {
      await chatList.waitFor({ timeout: loginTimeoutMs });
      return;
    } catch {
      // Not logged in (yet). Fall through to the QR flow below.
    }

    if (await qrCode.isVisible().catch(() => false)) {
      const seconds = Math.round(qrTimeoutMs / 1000);
      console.log(
        `\n📱 WhatsApp Web needs a login. Scan the QR code in the browser window\n` +
          `   (phone → WhatsApp → Settings → Linked devices → Link a device).\n` +
          `   Waiting up to ${seconds}s — do NOT close the window; the session is saved once you're in.\n`,
      );
      await chatList.waitFor({ timeout: qrTimeoutMs });
      console.log(
        "✓ Logged in — session saved to the local profile, future runs won't ask again.\n",
      );
      return;
    }

    throw new Error(
      "WhatsApp Web loaded but showed neither a chat list nor a QR code within " +
        `${Math.round(loginTimeoutMs / 1000)}s. If the page looks fine, WhatsApp's DOM may have ` +
        "changed — check the selectors in waSession.ts.",
    );
  }

  private composer() {
    if (!this.page) throw new Error("Session not open — call open() first");
    return this.page.locator('[contenteditable="true"][data-tab]').last();
  }

  /** Types multi-line text without sending early — a bare Enter inside WhatsApp's composer submits
   * the message, so newlines must go in as Shift+Enter. */
  private async typeIntoComposer(text: string): Promise<void> {
    const page = this.page!;
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i > 0) await page.keyboard.press("Shift+Enter");
      if (line) await page.keyboard.type(line);
    }
  }

  /** Actually dispatches the message, then PROVES it left the composer.
   *
   * Both halves matter. Pressing Enter on `page.keyboard` alone targets whatever happens to have
   * focus — if that isn't the composer the keystroke is swallowed and the text just sits there as a
   * draft, which is the exact failure this replaced. And without the emptied-composer check we'd
   * report a cheerful "sent" for a message still sitting unsent on screen; far better to throw so
   * the caller records a real failure the operator can see. */
  private async sendCurrentChat(): Promise<void> {
    const page = this.page!;
    const composer = this.composer();

    await composer.click(); // focus — the missing step that left messages in draft
    await page.waitForTimeout(300);

    const sendButton = page
      .locator('[data-icon="send"], [data-icon="wds-ic-send-filled"], [aria-label="Send"]')
      .first();
    if (await sendButton.isVisible().catch(() => false)) {
      await sendButton.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Poll for the composer to clear — that's WhatsApp's own signal the message was accepted.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const remaining = (await composer.innerText().catch(() => "")).trim();
      if (remaining === "") {
        await page.waitForTimeout(1200); // let the outbound request actually go out
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("Message stayed in the composer — not sent (still a draft).");
  }

  private async attachMedia(mediaPath: string): Promise<void> {
    const page = this.page!;
    await page
      .locator('[data-icon="attach-menu-plus"], [data-icon="clip"], [data-icon="plus-rounded"]')
      .first()
      .click();
    await page.locator('input[type="file"]').first().setInputFiles(mediaPath);
    await page.waitForTimeout(2500); // media preview has to render before it can be sent
  }

  /** Opens a 1:1 chat with `phoneDigits` (E.164 digits, no leading +), pre-filled with `text` via
   * the URL, and sends it. Optionally attaches a local file first (image/PDF/etc — the one
   * capability click-to-chat links can never offer, since wa.me only supports pre-filled text).
   * Throws if the chat/composer never loads (e.g. the number isn't on WhatsApp) or if the message
   * fails to leave the composer — the caller marks that recipient failed rather than retrying. */
  async sendTo(phoneDigits: string, text: string, mediaPath?: string): Promise<void> {
    if (!this.page) throw new Error("Session not open — call open() first");
    const chatTimeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 60_000);
    const url = `https://web.whatsapp.com/send?phone=${phoneDigits}&text=${encodeURIComponent(text)}`;
    await this.page.goto(url, { waitUntil: "commit", timeout: chatTimeoutMs });

    await this.composer().waitFor({ timeout: chatTimeoutMs });
    if (mediaPath) await this.attachMedia(mediaPath);
    await this.sendCurrentChat();
  }

  /** Sends to a GROUP by its exact chat name. Groups have no phone number, so the `?phone=` URL
   * trick is unavailable — the only route is the UI: search the chat list, open the match, type,
   * send. Name matching is exact-ish and case-sensitive to WhatsApp's own search; if several chats
   * match, the first result wins, so prefer distinctive group names. */
  async sendToGroup(groupName: string, text: string, mediaPath?: string): Promise<void> {
    if (!this.page) throw new Error("Session not open — call open() first");
    const page = this.page;
    const chatTimeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 60_000);

    if (!page.url().includes("web.whatsapp.com")) {
      await page.goto("https://web.whatsapp.com", { waitUntil: "commit", timeout: chatTimeoutMs });
    }

    const search = page
      .locator('[contenteditable="true"][data-tab="3"], [aria-label="Search input textbox"]')
      .first();
    await search.waitFor({ timeout: chatTimeoutMs });
    await search.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(groupName);
    await page.waitForTimeout(2000); // let results filter

    const result = page.locator(`span[title="${groupName}"]`).first();
    try {
      await result.waitFor({ timeout: 15_000 });
    } catch {
      throw new Error(`Group "${groupName}" not found in the chat list — check the exact name.`);
    }
    await result.click();

    await this.composer().waitFor({ timeout: chatTimeoutMs });
    if (mediaPath) await this.attachMedia(mediaPath);
    await this.composer().click();
    await this.typeIntoComposer(text);
    await page.waitForTimeout(300);
    await this.sendCurrentChat();
  }

  /** Closes the browser, giving Chromium a beat to flush first.
   *
   * This matters more than it looks: WhatsApp keeps its login in IndexedDB, which Chromium writes
   * lazily. Tearing the context down the instant a send finishes can drop those writes, so the
   * hard-won QR login silently fails to persist and the next run demands another scan. The pause
   * is what makes "log in once" actually hold across runs. */
  async close(): Promise<void> {
    try {
      await this.page?.waitForTimeout(2000);
    } catch {
      // Page already gone (operator closed the window) — nothing to flush, just close the context.
    }
    await this.context?.close();
  }
}
