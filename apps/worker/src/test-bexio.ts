// THE CORRECT placeholder per official bexio API docs: [Network Link]
// Send RE-00229 to IT Service Martin (Marcus = test customer with own email).

import { getDb, closeDb } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';

const db = getDb();
const token = await getValidAccessToken(db);
const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

console.log('POST /kb_invoice/229/send with [Network Link] placeholder');
const res = await fetch('https://api.bexio.com/2.0/kb_invoice/229/send', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    recipient_email: 'marcusmartini83@gmail.com',
    subject: 'bexio-bot Test — RE-00229',
    message: 'Hallo Marcus,\n\nDies ist eine Test-Rechnung vom bexio-bot.\n\nDie Rechnung kannst du hier einsehen: [Network Link]\n\nFreundliche Grüsse,\nDein bexio-bot',
    mark_as_open: true,
    attach_pdf: true,
  }),
});
const text = await res.text();
console.log(`  status: ${res.status}`);
console.log(`  body:   ${text.slice(0, 300)}`);

if (res.ok) {
  console.log('');
  console.log('*** EMAIL SENT *** — check marcusmartini83@gmail.com inbox');

  await new Promise((r) => setTimeout(r, 1200));
  const final = await fetch('https://api.bexio.com/2.0/kb_invoice/229', { headers: auth });
  const inv = (await final.json()) as { is_sent?: boolean; mail_sent_at?: string; kb_item_status_id: number };
  console.log(`Final state: is_sent=${inv.is_sent}  mail_sent_at=${inv.mail_sent_at}  status_id=${inv.kb_item_status_id}`);
}

await closeDb();
