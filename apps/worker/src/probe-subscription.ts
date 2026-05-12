// End-to-end live probe for the subscription pipeline.
// 1. Insert a tiny test subscription (CHF 0.01-class, monthly, today, no auto-send)
// 2. Call runSubscriptionNow to force billing
// 3. Print the result
// 4. Roll back: delete subscription, billing_runs, AND delete the bexio invoice
//
// SAFETY: this creates a real bexio invoice draft. Script attempts cleanup but
// if it crashes you must manually delete the invoice in bexio UI.
//
// Usage: bun run apps/worker/src/probe-subscription.ts <bexio_contact_id> <bexio_article_id>

import { eq } from 'drizzle-orm';
import { getDb, closeDb, subscriptions, subscriptionItems, billingRuns } from '@bexio-bot/db';
import { getValidAccessToken, BEXIO_API_BASE } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from './lib/subscriptions.ts';

const contactId = Number(process.argv[2]);
const articleId = Number(process.argv[3]);
if (!Number.isInteger(contactId) || contactId <= 0 || !Number.isInteger(articleId) || articleId <= 0) {
  console.error('Usage: bun run apps/worker/src/probe-subscription.ts <contact_id> <article_id>');
  process.exit(1);
}

const db = getDb();
let subId: number | undefined;
let invoiceId: number | undefined;

try {
  const accessToken = await getValidAccessToken(db);
  console.log('Token OK');

  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const [sub] = await db
    .insert(subscriptions)
    .values({
      bexioContactId: contactId,
      name: `PROBE-${Date.now()}`,
      interval: 'monthly',
      startDate: today,
      nextBillingDate: today,
      status: 'active',
      autoSend: false, // don't actually email anyone
    })
    .returning();

  if (!sub) throw new Error('failed to insert subscription');
  subId = sub.id;
  console.log(`Created subscription #${subId}`);

  await db.insert(subscriptionItems).values({
    subscriptionId: subId,
    bexioArticleId: articleId,
    qty: '1',
    positionOrder: 0,
  });

  console.log('Running subscription via runSubscriptionNow...');
  const result = await runSubscriptionNow(db, accessToken, subId);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (result.kind === 'sent') {
    invoiceId = result.invoiceId;
  }

  // Cleanup
  console.log('\n── Cleanup ──');
  if (invoiceId !== undefined) {
    const delRes = await fetch(`${BEXIO_API_BASE}/kb_invoice/${invoiceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    console.log(`  DELETE /kb_invoice/${invoiceId} → ${delRes.status}`);
  }
  await db.delete(billingRuns).where(eq(billingRuns.subscriptionId, subId));
  await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subId));
  await db.delete(subscriptions).where(eq(subscriptions.id, subId));
  console.log('  DB rows deleted.');
} catch (err) {
  console.error('FAIL:', err instanceof Error ? err.stack : String(err));
  if (subId !== undefined) console.error(`Manual cleanup needed: subscription #${subId}`);
  if (invoiceId !== undefined) console.error(`Manual cleanup needed: bexio invoice #${invoiceId}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
