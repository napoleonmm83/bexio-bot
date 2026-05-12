import { desc, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, billingRuns, subscriptions } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from '@bexio-bot/worker/subscriptions';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const runs = await db
    .select({
      id: billingRuns.id,
      subscriptionId: billingRuns.subscriptionId,
      scheduledFor: billingRuns.scheduledFor,
      executedAt: billingRuns.executedAt,
      status: billingRuns.status,
      bexioInvoiceId: billingRuns.bexioInvoiceId,
      errorJsonb: billingRuns.errorJsonb,
      createdAt: billingRuns.createdAt,
      subscriptionName: subscriptions.name,
    })
    .from(billingRuns)
    .leftJoin(subscriptions, eq(billingRuns.subscriptionId, subscriptions.id))
    .orderBy(desc(billingRuns.createdAt))
    .limit(100);
  return { runs };
};

export const actions: Actions = {
  retry: async ({ request }) => {
    const form = await request.formData();
    const subscriptionId = Number(form.get('subscription_id'));
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      return fail(400, { error: 'invalid subscription id' });
    }

    const db = getDb();
    const accessToken = await getValidAccessToken(db);
    const result = await runSubscriptionNow(db, accessToken, subscriptionId);
    return { success: true, result };
  },
};
