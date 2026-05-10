// One-shot bexio API smoke test. Verifies access token works + dumps shape of /kb_order.
// Usage: bun run apps/worker/src/test-bexio.ts
// Removed before Phase 1 — debugging only.

import { eq } from 'drizzle-orm';
import { getDb, secrets, closeDb } from '@bexio-bot/db';

const db = getDb();
const rows = await db.select().from(secrets).where(eq(secrets.key, 'bexio_access_token'));
const accessToken = rows[0]?.value;

if (!accessToken) {
  console.error('No access token in DB. Run `bun run oauth-setup` first.');
  await closeDb();
  process.exit(1);
}

console.log('Test 1: GET /2.0/kb_order?limit=5');
const ordersRes = await fetch('https://api.bexio.com/2.0/kb_order?limit=5', {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
console.log('  status:', ordersRes.status);

if (!ordersRes.ok) {
  console.log('  body:', (await ordersRes.text()).slice(0, 500));
  await closeDb();
  process.exit(1);
}

const orders = (await ordersRes.json()) as Array<Record<string, unknown>>;
console.log('  count:', orders.length);

if (orders.length > 0) {
  const sample = orders[0]!;
  console.log('  sample keys:', Object.keys(sample).join(', '));
  console.log('  sample id:', sample.id);
  console.log('  sample is_recurring:', sample.is_recurring ?? '(field missing — bexio API may not expose recurring flag here)');
}

await closeDb();
console.log('OK — bexio API reachable, access token valid.');
