// Discovery script: dump kb_item_status_id values across recurring orders so we
// know which IDs map to Offen/Teilweise/Erledigt/Storniert in this bexio account.
// (kb_item_status IDs vary per account; safer to inspect than hardcode upstream defaults.)

import { eq } from 'drizzle-orm';
import { getDb, secrets, closeDb } from '@bexio-bot/db';
import {
  getValidAccessToken,
  listRecurringOrders,
  getContact,
  formatContactName,
  BexioApiError,
} from '@bexio-bot/bexio-client';

const db = getDb();

try {
  const token = await getValidAccessToken(db);

  // Try discovering the status enum
  console.log('Step 1: GET /2.0/kb_order_status (if it exists)');
  const statusRes = await fetch('https://api.bexio.com/2.0/kb_order_status', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  console.log('  status:', statusRes.status);
  if (statusRes.ok) {
    const statuses = await statusRes.json();
    console.log('  body:', JSON.stringify(statuses, null, 2).slice(0, 800));
  } else {
    console.log('  (not available — fall back to per-order inspection)');
  }

  console.log('');
  console.log('Step 2: Per-order kb_item_status_id values');
  const orders = await listRecurringOrders(token);
  for (const o of orders) {
    let name = `Auftrag #${o.document_nr}`;
    try {
      const contact = await getContact(token, o.contact_id);
      name = formatContactName(contact);
    } catch {}
    // kb_item_status_id is in BexioOrder type but not in our public surface;
    // cast here for inspection
    const statusId = (o as { kb_item_status_id?: number }).kb_item_status_id;
    console.log(`  · ${o.document_nr.padEnd(10)} status_id=${String(statusId).padEnd(4)} ${name}`);
  }
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
