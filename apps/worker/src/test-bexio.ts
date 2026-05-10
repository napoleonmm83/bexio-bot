// Quick check what kb_item_status_id AU-00011 has now, and what repetition looks like

import { eq } from 'drizzle-orm';
import { getDb, secrets, closeDb } from '@bexio-bot/db';

const db = getDb();
const token = (await db.select().from(secrets).where(eq(secrets.key, 'bexio_access_token')))[0]!.value;

const order = await fetch('https://api.bexio.com/2.0/kb_order/11', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
const body = await order.json() as Record<string, unknown>;
console.log('AU-00011:');
console.log('  kb_item_status_id:', body.kb_item_status_id);
console.log('  is_recurring:     ', body.is_recurring);
console.log('  total:            ', body.total);
console.log('  is_valid_from:    ', body.is_valid_from);

const rep = await fetch('https://api.bexio.com/2.0/kb_order/11/repetition', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
console.log('');
console.log('Repetition:', await rep.text());

await closeDb();
