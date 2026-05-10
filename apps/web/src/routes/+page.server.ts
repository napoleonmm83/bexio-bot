// Dashboard data load. Parallel queries for status, today's invoices, due-this-week,
// open invoices, and order admin lists. Uses Promise.allSettled so one failed query
// doesn't blank the whole page.

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

  const enabledOrdersPromise = db
    .select()
    .from(recurringOrders)
    .where(eq(recurringOrders.enabled, true))
    .orderBy(recurringOrders.customerName);

  const disabledOrdersPromise = db
    .select()
    .from(recurringOrders)
    .where(eq(recurringOrders.enabled, false))
    .orderBy(recurringOrders.customerName);

  const [lastRunSettled, todaySettled, enabledSettled, disabledSettled] = await Promise.allSettled([
    lastRunPromise,
    todayInvoicesPromise,
    enabledOrdersPromise,
    disabledOrdersPromise,
  ]);

  return {
    lastRun: lastRunSettled.status === 'fulfilled' ? (lastRunSettled.value[0] ?? null) : null,
    todayInvoices: todaySettled.status === 'fulfilled' ? todaySettled.value : [],
    enabledOrders: enabledSettled.status === 'fulfilled' ? enabledSettled.value : [],
    disabledOrders: disabledSettled.status === 'fulfilled' ? disabledSettled.value : [],
    errors: [
      ...(lastRunSettled.status === 'rejected' ? [`lastRun: ${lastRunSettled.reason}`] : []),
      ...(todaySettled.status === 'rejected' ? [`todayInvoices: ${todaySettled.reason}`] : []),
      ...(enabledSettled.status === 'rejected' ? [`enabledOrders: ${enabledSettled.reason}`] : []),
      ...(disabledSettled.status === 'rejected' ? [`disabledOrders: ${disabledSettled.reason}`] : []),
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
