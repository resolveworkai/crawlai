// Authored by: Mohit Singh
//
// ONE-COMMAND dev launcher — `npm run dev` from backend/api brings up the ENTIRE stack with zero
// other manual steps:
//   - the backend API itself
//   - the frontend (root `vite dev`) — so the UI (incl. the sidebar/routes) is always served from
//     the SAME code you just started the backend from; no separate "cd to the repo root and run
//     npm run dev there too" step, no stale/mismatched frontend process
//   - the WhatsApp automation agent (backend/whatsapp-sender), if it's been set up (.env exists)
//   - the noon.com + AliExpress host runner (run_noon_host.py) and the dubizzle/propertyfinder
//     host runner (run_property_host.py) — both need a real, CDP-attached Chrome (see
//     scripts/start-noon-host.bat / start-property-host.bat, which this replaces for local dev:
//     `npm run dev` now does automatically what those .bat files did manually), including
//     launching that Chrome itself if one isn't already listening on the debug port.
// Optional pieces degrade silently (no error, just a log line) when their prerequisite isn't
// present — e.g. no .env for the WhatsApp agent, no Chrome install for the host runners — so this
// stays a true no-manual-work single command for anyone regardless of what they've set up.
//
// Never touches the Docker image — the container's entrypoint runs the built server directly, not
// `npm run dev` (see backend/docker-entrypoint.sh), so this has zero effect on any deployment;
// `docker compose up --build` already brings up backend+frontend together on its own (only the
// host runners are unreachable from inside a container — see their own log message below).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiDir, "../..");
const agentDir = path.resolve(apiDir, "../whatsapp-sender");
const agentEnvPath = path.join(agentDir, ".env");
const workerDir = path.resolve(apiDir, "../worker");

const isWindows = process.platform === "win32";
const children = [];

// The backend hard-requires DATABASE_URL to boot at all (config.ts — every other env var has a
// default or is optional) and there is no backend/api/.env file in this repo, so a plain
// `npm run dev` with nothing exported first crashes immediately with "Invalid environment
// configuration: DATABASE_URL Required" — a real manual-setup step this launcher is supposed to
// eliminate. Default matches docker-compose.yml's postgres service (host-published port 5436) —
// the same DB the host runners below already default to; an explicitly-exported DATABASE_URL
// always wins.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:1234@localhost:5436/master_db_crawler";

function spawnTagged(name, command, args, cwd, extraEnv) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: isWindows,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  children.push(child);
  child.on("error", (err) => {
    console.log(`[dev] ${name} failed to start: ${err.message}`);
  });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (code ${code})`);
  });
  return child;
}

spawnTagged("backend", "npx", ["tsx", "watch", "src/server.ts"], apiDir, { DATABASE_URL });
spawnTagged("frontend", "npm", ["run", "dev"], repoRoot);

if (existsSync(agentEnvPath)) {
  console.log("[dev] whatsapp-sender/.env found — starting the WhatsApp automation agent alongside the backend.");
  spawnTagged("agent", "npm", ["run", "agent"], agentDir);
} else {
  console.log(
    "[dev] whatsapp-sender/.env not found — skipping the WhatsApp agent " +
      "(see backend/whatsapp-sender/README.md to set it up).",
  );
}

// --- noon/AliExpress + dubizzle/propertyfinder host runners ------------------------------------
// Both need a REAL Chrome (CDP-attached) — those platforms block plain headless/automated
// browsers. Mirrors what scripts/start-noon-host.bat and scripts/start-property-host.bat do by
// hand: launch one shared debug Chrome (both host runners attach to the same instance — they
// watch different job tables, so running them concurrently against one browser is safe), then run
// both watchers. Set SKIP_HOST_RUNNERS=1 to opt out (e.g. no Chrome on this machine, or you'd
// rather run the .bat files yourself with a different CDP port).
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

function findChromeExe() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((p) => existsSync(p));
}

async function isChromeDebugPortOpen() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startHostRunners() {
  if (!isWindows) {
    console.log(
      "[dev] Host runners (noon/dubizzle/propertyfinder — need a real Chrome via CDP) are " +
        "Windows-only — skipping on this platform.",
    );
    return;
  }
  if (process.env.SKIP_HOST_RUNNERS === "1") {
    console.log("[dev] SKIP_HOST_RUNNERS=1 — not auto-starting the host runners.");
    return;
  }

  const alreadyOpen = await isChromeDebugPortOpen();
  if (!alreadyOpen) {
    const chromeExe = findChromeExe();
    if (!chromeExe) {
      console.log(
        "[dev] Chrome not found at the usual install paths — skipping the noon/dubizzle/" +
          "propertyfinder host runners (install Chrome, or run scripts/start-noon-host.bat / " +
          "start-property-host.bat manually once it's available).",
      );
      return;
    }
    console.log(`[dev] Starting debug Chrome on ${CDP_URL} ...`);
    const chrome = spawn(
      chromeExe,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${path.join(process.env.TEMP ?? "C:\\Temp", "noon-cdp-chrome")}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: "ignore" },
    );
    chrome.on("error", (err) => console.log(`[dev] Chrome failed to start: ${err.message}`));
    // Detached + unref'd — Chrome keeps running independently of this dev process, same as the
    // .bat launchers' `start ""` behavior (closing the terminal doesn't close the browser).
    chrome.unref();
    // Give Chrome a moment to open the debug port before the watchers first connect.
    await new Promise((r) => setTimeout(r, 4000));
  } else {
    console.log(`[dev] Debug Chrome already listening on ${CDP_URL} — reusing it.`);
  }

  const pythonExe = existsSync(path.join(workerDir, ".venv", "Scripts", "python.exe"))
    ? path.join(workerDir, ".venv", "Scripts", "python.exe")
    : "python";

  console.log("[dev] Starting noon/AliExpress host runner (watch mode)...");
  spawnTagged("noon-host", pythonExe, ["run_noon_host.py"], workerDir, {
    DATABASE_URL,
    ECOM_CDP_URL: CDP_URL,
    ECOM_HOST_WATCH: "1",
    ECOM_HOST_POLL_SECONDS: process.env.ECOM_HOST_POLL_SECONDS ?? "15",
    PYTHONIOENCODING: "utf-8",
  });

  console.log("[dev] Starting dubizzle/propertyfinder host runner (watch mode)...");
  spawnTagged("property-host", pythonExe, ["run_property_host.py"], workerDir, {
    DATABASE_URL,
    PROPERTY_CDP_URL: CDP_URL,
    PROPERTY_HOST_WATCH: "1",
    PROPERTY_HOST_POLL_SECONDS: process.env.PROPERTY_HOST_POLL_SECONDS ?? "15",
    PYTHONIOENCODING: "utf-8",
  });
}

void startHostRunners();

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
