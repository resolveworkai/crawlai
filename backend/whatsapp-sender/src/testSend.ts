#!/usr/bin/env node
/** Authored by: Mohit Singh */
//
// `npm run test-send [-- --message "custom text"]` — run this BEFORE `npm run send` against a real
// campaign. Sends one trial message to TEST_PHONE_NUMBER (default +919560397112 — set your own
// number in .env) so you can confirm the automation actually works end-to-end first.
import "dotenv/config";
import {
  DEFAULT_TEST_MESSAGE,
  DEFAULT_TEST_PHONE,
  sendTrialMessage,
  sendTrialToGroup,
} from "./trialSend.js";

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const message = argValue(argv, "--message") ?? DEFAULT_TEST_MESSAGE;
  const group = argValue(argv, "--group");

  if (group) {
    console.log(`Sending a trial message to GROUP "${group}"…\n`);
    await sendTrialToGroup(group, message);
    console.log(`\n✓ Sent to group "${group}". Check the group to confirm it arrived.`);
    return;
  }

  const phone = argValue(argv, "--phone") ?? DEFAULT_TEST_PHONE;
  console.log(`Sending a trial message to ${phone}…\n`);
  await sendTrialMessage(phone, message);
  console.log(
    `\n✓ Trial message sent. Check that phone to confirm it arrived correctly, then run a real campaign with npm run send.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
