// Read-only diagnostic — verify the worker can talk to bexio + DB.
// Lists current state without any mutation. Safe to run anytime.
//
// Usage: bun run test-bexio

import { eq, count } from 'drizzle-orm';
import { getDb, closeDb, recurringOrders, botRuns, invoiceRuns } from '@bexio-bot/db';
import { getValidAccessToken, listRecurringOrders, BexioApiError } from '@bexio-bot/bexio-client';

const db = getDb();

try {
  // 1. DB connectivity
  const [{ value: orderCount }] = await db.select({ value: count() }).from(recurringOrders);
  const [{ value: runCount }] = await db.select({ value: count() }).from(botRuns);
  const [{ value: invRunCount }] = await db.select({ value: count() }).from(invoiceRuns);
  console.log('DB:');
  console.log(`  recurring_orders: ${orderCount}`);
  console.log(`  bot_runs:         ${runCount}`);
  console.log(`  invoice_runs:     ${invRunCount}`);

  // 2. OAuth + token refresh
  console.log('');
  console.log('bexio:');
  const token = await getValidAccessToken(db);
  console.log(`  token: ${token.length} chars (refresh-aware)`);

  // 3. List recurring orders from bexio
  const orders = await listRecurringOrders(token);
  console.log(`  recurring orders: ${orders.length} from bexio`);

  // 4. Enabled orders summary
  console.log('');
  console.log('Bot scope:');
  const enabled = await db.select().from(recurringOrders).where(eq(recurringOrders.enabled, true));
  console.log(`  enabled orders: ${enabled.length}`);
  for (const o of enabled) {
    console.log(`    · #${o.bexioOrderId} ${o.customerName} (${o.interval}, ${o.bexioStatus})`);
    console.log(`      email: ${o.customerEmail ?? 'MISSING'}  next: ${o.nextBillingDate.toISOString().slice(0, 10)}`);
  }

  console.log('');
  console.log('OK — full stack verified.');
} catch (err) {
  if (err instanceof BexioApiError) {
    console.error(`FAIL — BexioApiError ${err.status} (${err.errorClass}):`, err.body.slice(0, 300));
  } else {
    console.error('FAIL —', err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
} finally {
  await closeDb();
}
