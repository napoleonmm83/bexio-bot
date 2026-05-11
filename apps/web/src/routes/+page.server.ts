// Dashboard data load. One unified query for all orders + side queries for the
// run-status banner and today's invoice activity. Client-side filter/search/sort
// handles the rest — works comfortably up to ~1k rows; switch to server-side
// pagination if we ever cross that.

import { desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, recurringOrders, invoiceRuns, botRuns } from '@bexio-bot/db';

export const load: PageServerLoad = async () => {
  const db = getDb();

  const lastRunPromise = db
    .select()
    .from(botRuns)
    .orderBy(desc(botRuns.startedAt))
    .limit(1);

  const todayInvoicesPromise = db
    .select()
    .from(invoiceRuns)
    .where(sql`${invoiceRuns.sentAt}::date = current_date OR ${invoiceRuns.updatedAt}::date = current_date`)
    .orderBy(desc(invoiceRuns.updatedAt));

  // One query for the whole table. Sort by next-due so overdue + soon-due
  // bubble up; nulls last so "no next date" rows don't crowd the head.
  const ordersPromise = db
    .select()
    .from(recurringOrders)
    .orderBy(sql`${recurringOrders.nextBillingDate} ASC NULLS LAST`, recurringOrders.customerName);

  const [lastRunSettled, todaySettled, ordersSettled] = await Promise.allSettled([
    lastRunPromise,
    todayInvoicesPromise,
    ordersPromise,
  ]);

  return {
    lastRun: lastRunSettled.status === 'fulfilled' ? (lastRunSettled.value[0] ?? null) : null,
    todayInvoices: todaySettled.status === 'fulfilled' ? todaySettled.value : [],
    orders: ordersSettled.status === 'fulfilled' ? ordersSettled.value : [],
    errors: [
      ...(lastRunSettled.status === 'rejected' ? [`lastRun: ${lastRunSettled.reason}`] : []),
      ...(todaySettled.status === 'rejected' ? [`todayInvoices: ${todaySettled.reason}`] : []),
      ...(ordersSettled.status === 'rejected' ? [`orders: ${ordersSettled.reason}`] : []),
    ],
  };
};

export const actions: Actions = {
  toggle: async ({ request }) => {
    const data = await request.formData();
    const orderId = Number(data.get('orderId'));
    const enabled = data.get('enabled') === 'true';

    if (!Number.isFinite(orderId)) {
      return { success: false, error: 'invalid orderId' };
    }

    const db = getDb();
    await db
      .update(recurringOrders)
      .set({ enabled })
      .where(eq(recurringOrders.bexioOrderId, orderId));

    return { success: true };
  },
};
