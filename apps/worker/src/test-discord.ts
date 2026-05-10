// Smoke test for the Discord webhook adapter — sends a single test message.
// Use to verify DISCORD_WEBHOOK_URL is correct before relying on it for the worker run.
//
// Usage: bun run test-discord

import { sendDiscordMessage } from '@bexio-bot/notify';

const url = process.env.DISCORD_WEBHOOK_URL;
if (!url) {
  console.error('DISCORD_WEBHOOK_URL not set');
  process.exit(1);
}

console.log('Sending test message to Discord webhook...');
const result = await sendDiscordMessage(
  url,
  'bexio-bot test message — wenn du das siehst, ist der Webhook richtig konfiguriert.',
);

if (result.ok) {
  console.log('OK — Discord message delivered.');
} else {
  console.error(`FAIL — ${'status' in result && result.status ? `${result.status}: ` : ''}${result.error}`);
  process.exit(1);
}
