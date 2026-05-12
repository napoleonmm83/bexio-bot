// Subscription list. Sorted by next-billing-date (overdue/due-soon first).
// Joined with last billing_run per subscription so the table shows recent status
// at a glance.

import { sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types.ts';
import { getDb, subscriptions } from '@bexio-bot/db';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const subs = await db
    .select()
    .from(subscriptions)
    .orderBy(sql`${subscriptions.nextBillingDate} ASC NULLS LAST`, subscriptions.name);

  // Latest billing_run per subscription for status display.
  // Using raw execute() because DISTINCT ON is Postgres-specific and cleaner here.
  const lastRunsResult = await db.execute<{
    subscription_id: number;
    status: string;
    executed_at: Date | null;
    bexio_invoice_id: number | null;
  }>(sql`
    SELECT DISTINCT ON (subscription_id) subscription_id, status, executed_at, bexio_invoice_id
    FROM billing_runs
    ORDER BY subscription_id, created_at DESC
  `);

  const lastRunMap = new Map(
    lastRunsResult.map((r) => [r.subscription_id, r]),
  );

  return {
    subscriptions: subs.map((s) => ({
      ...s,
      lastRun: lastRunMap.get(s.id) ?? null,
    })),
  };
};
