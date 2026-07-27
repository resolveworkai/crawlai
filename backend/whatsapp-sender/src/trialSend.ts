/** Authored by: Mohit Singh */
//
// Standalone trial/smoke-test send — confirms the browser automation (persisted login session,
// WhatsApp Web selectors, an actual message landing) works BEFORE pointing it at real business
// leads via a real campaign. Sends one message to a fixed test number, no campaign/API involved.
// Shared by the CLI (testSend.ts) and the agent's POST /test-send.
import { WaSession } from "./waSession.js";

export const DEFAULT_TEST_PHONE = process.env.TEST_PHONE_NUMBER ?? "+919560397112";
export const DEFAULT_TEST_MESSAGE =
  "This is a trial message from the WhatsApp Sender Agent — confirming the automation works " +
  "before it's pointed at real business leads.";

export async function sendTrialMessage(
  phone: string = DEFAULT_TEST_PHONE,
  message: string = DEFAULT_TEST_MESSAGE,
): Promise<void> {
  const digits = phone.replace(/[^\d]/g, "");
  const wa = new WaSession();
  await wa.open();
  try {
    await wa.sendTo(digits, message);
  } finally {
    await wa.close();
  }
}
