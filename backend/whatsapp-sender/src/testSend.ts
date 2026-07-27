#!/usr/bin/env node
/** Authored by: Mohit Singh */
//
// `npm run test-send [-- --message "custom text"]` — run this BEFORE `npm run send` against a real
// campaign. Sends one trial message to TEST_PHONE_NUMBER (default +919560397112 — set your own
// number in .env) so you can confirm the automation actually works end-to-end first.
import "dotenv/config";
import { DEFAULT_TEST_MESSAGE, DEFAULT_TEST_PHONE, sendTrialMessage } from "./trialSend.js";

function parseMessage(argv: string[]): string {
  const idx = argv.indexOf("--message");
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1]! : DEFAULT_TEST_MESSAGE;
}

async function main(): Promise<void> {
  const message = parseMessage(process.argv.slice(2));
  console.log(`Sending a trial message to ${DEFAULT_TEST_PHONE}…\n`);
  await sendTrialMessage(DEFAULT_TEST_PHONE, message);
  console.log(
    `\n✓ Trial message sent. Check that phone to confirm it arrived correctly, then run a real campaign with npm run send.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
