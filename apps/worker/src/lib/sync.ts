// Sync bexio recurring orders into the local recurring_orders cache.
// Rule: new orders inserted with enabled=false (Marcus opts in via dashboard).
// Existing orders preserve their enabled flag.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { recurringOrders } from '@bexio-bot/db';
import {
  listRecurringOrders,
  getOrderRepetition,
  getContact,
  formatContactName,
  mapBexioStatus,
  mapRepetitionToInterval,
  type BexioOrderRepetition,
} from '@bexio-bot/bexio-client';
import { computeNextBilling } from './next-billing.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

export type SyncResult = {
  total: number;
  newlyAdded: number;
  alreadyTracked: number;
  newOrders: Array<{ bexioOrderId: number; customerName: string; interval: string }>;
};

export async function syncRecurringOrders(db: Db, accessToken: string): Promise<SyncResult> {
  const orders = await listRecurringOrders(accessToken);

  let newlyAdded = 0;
  let alreadyTracked = 0;
  const newOrders: SyncResult['newOrders'] = [];

  // Cache contacts so two orders from the same customer don't trigger two API calls
  const contactCache = new Map<number, string>();

  for (const o of orders) {
    // Fetch repetition config — bexio doesn't include it in the order body
    let interval: 'monthly' | 'quarterly' | 'semi_annual' | 'yearly';
    let nextBillingDate: Date;
    try {
      const rep = await getOrderRepetition(accessToken, o.id);
      interval = mapRepetitionToInterval(rep);
      nextBillingDate = computeNextBilling(rep) ?? new Date(); // null → fall through to today
    } catch {
      // /repetition can 404 for non-recurring orders; we filter is_recurring=true upstream
      // so this should be rare. Fall back to monthly + today as the safest default.
      interval = 'monthly';
      nextBillingDate = new Date();
    }

    let customerName = contactCache.get(o.contact_id);
    if (!customerName) {
      try {
        const contact = await getContact(accessToken, o.contact_id);
        customerName = formatContactName(contact);
      } catch {
        // bexio returned an error fetching the contact; fall back to order metadata.
        customerName = o.title || `Auftrag #${o.document_nr}`;
      }
      contactCache.set(o.contact_id, customerName);
    }

    const bexioStatus = mapBexioStatus(o.kb_item_status_id);

    // INSERT ... ON CONFLICT — if row exists, refresh cache fields incl. status.
    // Never touch `enabled` — that's the user's opt-in.
    const result = await db
      .insert(recurringOrders)
      .values({
        bexioOrderId: o.id,
        customerId: o.contact_id,
        customerName,
        interval,
        expectedAmount: o.total,
        nextBillingDate,
        enabled: false,
        bexioStatus,
        bexioStatusId: o.kb_item_status_id ?? null,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: recurringOrders.bexioOrderId,
        set: {
          customerName,
          interval,
          expectedAmount: o.total,
          nextBillingDate, // refresh — start date may shift in bexio
          bexioStatus,
          bexioStatusId: o.kb_item_status_id ?? null,
          syncedAt: new Date(),
        },
      })
      .returning({ inserted: sql<boolean>`xmax = 0` });

    const wasInsert = result[0]?.inserted ?? false;
    if (wasInsert) {
      newlyAdded += 1;
      newOrders.push({ bexioOrderId: o.id, customerName, interval });
    } else {
      alreadyTracked += 1;
    }
  }

  return { total: orders.length, newlyAdded, alreadyTracked, newOrders };
}

/**
 * Get all orders the worker should actually process.
 * Filters: enabled=true AND bexio status is open or partial.
 * Done/canceled/unknown are skipped — done invoices are paid, canceled orders
 * shouldn't be billed, unknown is a defensive default for new bexio status IDs
 * we haven't mapped yet.
 */
export async function getEnabledOrders(db: Db) {
  return db
    .select()
    .from(recurringOrders)
    .where(
      and(
        eq(recurringOrders.enabled, true),
        inArray(recurringOrders.bexioStatus, ['open', 'partial']),
      ),
    );
}
