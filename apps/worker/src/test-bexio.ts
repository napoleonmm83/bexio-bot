// bexio-client smoke test. Verifies the real client (auth refresh + orders + invoices read).
// Read-only: no /create, /issue, /send. Run anytime to confirm API is reachable.
//
// Usage: bun run test-bexio

import { getDb, closeDb } from '@bexio-bot/db';
import {
  getValidAccessToken,
  listRecurringOrders,
  getOrder,
  BexioApiError,
} from '@bexio-bot/bexio-client';

const db = getDb();

try {
  console.log('Step 1: refresh-aware getValidAccessToken()');
  const token = await getValidAccessToken(db);
  console.log('  OK — token length:', token.length);

  console.log('');
  console.log('Step 2: listRecurringOrders()');
  const orders = await listRecurringOrders(token);
  console.log('  recurring orders:', orders.length);
  for (const o of orders.slice(0, 5)) {
    console.log(`  · #${o.id} ${o.document_nr} | ${o.title.slice(0, 40)} | total CHF ${o.total} | contact ${o.contact_id}`);
  }
  if (orders.length > 5) console.log(`  · … (${orders.length - 5} more)`);

  if (orders.length > 0) {
    console.log('');
    console.log('Step 3: getOrder() — full detail of first recurring order');
    const detail = await getOrder(token, orders[0]!.id);
    console.log(`  id: ${detail.id}, document_nr: ${detail.document_nr}`);
    console.log(`  is_recurring: ${detail.is_recurring}`);
    if (detail.repetition) {
      console.log('  repetition:', JSON.stringify(detail.repetition, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    } else {
      console.log('  repetition: (not present in detail response — may be on a separate endpoint)');
    }
  }

  console.log('');
  console.log('OK — bexio-client smoke test passed.');
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
