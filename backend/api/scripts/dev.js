// Authored by: Mohit Singh
//
// Dev launcher: always starts the backend API, and ALSO starts the WhatsApp automation agent
// (backend/whatsapp-sender) alongside it — but only if that package has already been set up
// (its .env exists). This keeps `npm run dev` a no-op for anyone who's never touched the agent
// (no extra process, no warnings), while giving an operator who HAS configured it the convenience
// of "restart the backend, the agent comes back too" without a second terminal.
//
// Never touches the Docker image — the container's entrypoint runs the built server directly, not
// `npm run dev` (see backend/docker-entrypoint.sh), so this has zero effect on any deployment.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "..");
const agentDir = path.resolve(apiDir, "../whatsapp-sender");
const agentEnvPath = path.join(agentDir, ".env");

const isWindows = process.platform === "win32";
const children = [];

function spawnTagged(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: isWindows });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (code ${code})`);
  });
  return child;
}

spawnTagged("backend", "npx", ["tsx", "watch", "src/server.ts"], apiDir);

if (existsSync(agentEnvPath)) {
  console.log("[dev] whatsapp-sender/.env found — starting the WhatsApp automation agent alongside the backend.");
  spawnTagged("agent", "npm", ["run", "agent"], agentDir);
} else {
  console.log(
    "[dev] whatsapp-sender/.env not found — skipping the WhatsApp agent " +
      "(see backend/whatsapp-sender/README.md to set it up).",
  );
}

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
