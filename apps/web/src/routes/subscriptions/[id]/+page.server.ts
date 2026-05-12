import { eq, desc } from 'drizzle-orm';
import { fail, error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import {
  getDb,
  subscriptions,
  subscriptionItems,
  billingRuns,
} from '@bexio-bot/db';
import { getValidAccessToken, getArticle } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from '@bexio-bot/worker/subscriptions';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) throw error(400, 'invalid id');

  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  if (!sub) throw error(404, 'not found');

  const items = await db
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, id))
    .orderBy(subscriptionItems.positionOrder);

  const runs = await db
    .select()
    .from(billingRuns)
    .where(eq(billingRuns.subscriptionId, id))
    .orderBy(desc(billingRuns.createdAt))
    .limit(20);

  // Resolve article names from bexio for display (best-effort).
  const articleNames = new Map<number, string>();
  try {
    const accessToken = await getValidAccessToken(db);
    const articles = await Promise.all(
      items.map((i) => getArticle(accessToken, i.bexioArticleId).catch(() => null)),
    );
    for (const a of articles) {
      if (a) articleNames.set(a.id, `${a.intern_name} (${a.intern_code})`);
    }
  } catch {
    // fall through with empty map
  }

  return {
    subscription: sub,
    items: items.map((i) => ({
      ...i,
      articleName: articleNames.get(i.bexioArticleId) ?? `Artikel #${i.bexioArticleId}`,
    })),
    runs,
  };
};

export const actions: Actions = {
  pause: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id)) return fail(400, { error: 'invalid id' });
    const db = getDb();
    await db
      .update(subscriptions)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(subscriptions.id, id));
    return { success: true };
  },

  resume: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id)) return fail(400, { error: 'invalid id' });
    const db = getDb();
    // Reset next_billing_date to today so the next cron picks it up.
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    await db
      .update(subscriptions)
      .set({ status: 'active', nextBillingDate: today, updatedAt: new Date() })
      .where(eq(subscriptions.id, id));
    return { success: true };
  },

  cancel: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id)) return fail(400, { error: 'invalid id' });
    const db = getDb();
    await db
      .update(subscriptions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(subscriptions.id, id));
    return { success: true };
  },

  runNow: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id)) return fail(400, { error: 'invalid id' });
    const db = getDb();
    const accessToken = await getValidAccessToken(db);
    const result = await runSubscriptionNow(db, accessToken, id);
    return { success: true, runResult: result };
  },
};
