// /runs — last 30 days of bot runs + last 50 invoice runs.
// No join: bot_runs and invoice_runs aren't directly linked. Marcus correlates by timestamp.

import { desc, gte, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types.ts';
import { getDb, botRuns, invoiceRuns, recurringOrders } from '@bexio-bot/db';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const load: PageServerLoad = async () => {
  const db = getDb();
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const runsPromise = db
    .select()
    .from(botRuns)
    .where(gte(botRuns.startedAt, since))
    .orderBy(desc(botRuns.startedAt))
    .limit(100);

  // Invoice runs joined with customer name from recurring_orders so the page is
  // useful without correlating to bexio every time.
  const invoicesPromise = db
    .select({
      orderId: invoiceRuns.orderId,
      billingPeriod: invoiceRuns.billingPeriod,
      invoiceId: invoiceRuns.invoiceId,
      status: invoiceRuns.status,
      attempts: invoiceRuns.attempts,
      issuedAt: invoiceRuns.issuedAt,
      sentAt: invoiceRuns.sentAt,
      errorJsonb: invoiceRuns.errorJsonb,
      updatedAt: invoiceRuns.updatedAt,
      customerName: recurringOrders.customerName,
    })
    .from(invoiceRuns)
    .leftJoin(recurringOrders, sql`${invoiceRuns.orderId} = ${recurringOrders.bexioOrderId}`)
    .orderBy(desc(invoiceRuns.updatedAt))
    .limit(50);

  const [runsSettled, invoicesSettled] = await Promise.allSettled([runsPromise, invoicesPromise]);

  return {
    runs: runsSettled.status === 'fulfilled' ? runsSettled.value : [],
    invoices: invoicesSettled.status === 'fulfilled' ? invoicesSettled.value : [],
    errors: [
      ...(runsSettled.status === 'rejected' ? [`runs: ${runsSettled.reason}`] : []),
      ...(invoicesSettled.status === 'rejected' ? [`invoices: ${invoicesSettled.reason}`] : []),
    ],
  };
};
