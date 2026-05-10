// Discovery: what `type` values does bexio's /kb_order/{id}/repetition POST accept?
// We send POSTs with deliberately invalid types and read bexio's validation errors.
// If bexio replies with "type must be one of: X, Y, Z" we have the canonical list.
// If it just says "invalid", we fall back to trying common values one at a time.
//
// SAFETY: This OVERWRITES the repetition config on AU-00011. Marcus confirmed
// AU-00011 is a test customer and is currently disabled in the bot.

import { eq } from 'drizzle-orm';
import { getDb, secrets, closeDb } from '@bexio-bot/db';

const db = getDb();
const token = (await db.select().from(secrets).where(eq(secrets.key, 'bexio_access_token')))[0]!.value;
const URL = 'https://api.bexio.com/2.0/kb_order/11/repetition';

async function probe(label: string, body: object): Promise<{ status: number; body: string }> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${label.padEnd(35)} → ${res.status}  ${text.slice(0, 180)}`);
  await new Promise((r) => setTimeout(r, 1200));
  return { status: res.status, body: text };
}

const today = new Date().toISOString().slice(0, 10);
const base = { start: today };

console.log('Probing valid type values via bexio validation errors:');
console.log('');
console.log('--- Single-word types ---');
await probe('type=invalid_garbage', { ...base, repetition: { type: 'invalid_garbage', interval: 1 } });
await probe('type=monthly', { ...base, repetition: { type: 'monthly', interval: 1 } });
await probe('type=weekly', { ...base, repetition: { type: 'weekly', interval: 1, weekdays: ['monday'] } });
await probe('type=yearly', { ...base, repetition: { type: 'yearly', interval: 1 } });
await probe('type=daily', { ...base, repetition: { type: 'daily', interval: 1 } });
await probe('type=quarterly', { ...base, repetition: { type: 'quarterly', interval: 1 } });
await probe('type=half_year', { ...base, repetition: { type: 'half_year', interval: 1 } });
await probe('type=halfyearly', { ...base, repetition: { type: 'halfyearly', interval: 1 } });
await probe('type=biweekly', { ...base, repetition: { type: 'biweekly', interval: 1 } });
await probe('type=fortnightly', { ...base, repetition: { type: 'fortnightly', interval: 1 } });

console.log('');
console.log('Reading current state back ---');
const final = await fetch(URL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
console.log(`GET status: ${final.status}, body: ${(await final.text()).slice(0, 300)}`);

await closeDb();
