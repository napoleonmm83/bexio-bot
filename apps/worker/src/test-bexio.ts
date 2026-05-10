import { getDb, closeDb } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { createInvoiceFromOrder, BexioApiError } from '@bexio-bot/bexio-client';

const db = getDb();
const token = await getValidAccessToken(db);
console.log('Got token (length):', token.length);
console.log('Token scopes (decoded):', JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).scope);

// Path 1: raw fetch like my probes — no body
console.log('');
console.log('--- raw fetch POST /kb_order/12/invoice (no body) ---');
const r1 = await fetch('https://api.bexio.com/2.0/kb_order/12/invoice', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
console.log(`status=${r1.status}  body=${(await r1.text()).slice(0, 200)}`);

// Path 2: through callBexio (what the worker uses)
console.log('');
console.log('--- createInvoiceFromOrder() via callBexio() ---');
try {
  const inv = await createInvoiceFromOrder(token, { order_id: 12 });
  console.log('SUCCESS:', JSON.stringify(inv).slice(0, 200));
} catch (err) {
  if (err instanceof BexioApiError) {
    console.log(`BexioApiError status=${err.status}  body=${err.body.slice(0, 200)}`);
  } else {
    console.log('Other error:', err);
  }
}

await closeDb();
