// Sync bexio recurring orders into the local recurring_orders cache.
// Rule: new orders inserted with enabled=false (Marcus opts in via dashboard).
// Existing orders preserve their enabled flag.

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { recurringOrders } from '@bexio-bot/db';
import {
  listRecurringOrders,
  getOrderRepetition,
  getContact,
  formatContactName,
  mapBexioStatus,
  mapRepetitionToInterval,
  isSupportedBexioInterval,
  type BexioOrderRepetition,
} from '@bexio-bot/bexio-client';
import { computeNextBilling } from './next-billing.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

export type SyncResult = {
  total: number;
  newlyAdded: number;
  alreadyTracked: number;
  /** Orders removed because they no longer exist (or no longer have is_recurring=true) in bexio. */
  removedOrders: number;
  newOrders: Array<{ bexioOrderId: number; customerName: string; interval: string }>;
  /** Orders whose bexio repetition.type is unsupported (weekly/daily/custom).
   *  Bot won't process them — Marcus needs to handle them manually in bexio. */
  unsupportedOrders: Array<{ bexioOrderId: number; customerName: string; bexioType: string }>;
};

export async function syncRecurringOrders(db: Db, accessToken: string): Promise<SyncResult> {
  const orders = await listRecurringOrders(accessToken);

  let newlyAdded = 0;
  let alreadyTracked = 0;
  const newOrders: SyncResult['newOrders'] = [];
  const unsupportedOrders: SyncResult['unsupportedOrders'] = [];
  const seenIds = new Set<number>();

  // Cache contacts so two orders from the same customer don't trigger two API calls
  const contactCache = new Map<number, string>();

  for (const o of orders) {
    seenIds.add(o.id);
    // Fetch repetition config — bexio doesn't include it in the order body
    let interval: 'monthly' | 'quarterly' | 'semi_annual' | 'yearly';
    let nextBillingDate: Date;
    let unsupportedType: string | undefined;
    try {
      const rep = await getOrderRepetition(accessToken, o.id);
      interval = mapRepetitionToInterval(rep);
      nextBillingDate = computeNextBilling(rep) ?? new Date();
      if (!isSupportedBexioInterval(rep)) {
        unsupportedType = rep?.repetition?.type ?? 'unknown';
      }
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

    if (unsupportedType) {
      unsupportedOrders.push({ bexioOrderId: o.id, customerName, bexioType: unsupportedType });
    }
  }

  // Clean up orphans: orders that used to be in bexio but are gone now
  // (deleted, status changed so they're no longer is_recurring, etc.)
  // invoice_runs has no FK back to recurring_orders so orphan rows there are fine.
  let removedOrders = 0;
  const seenArray = [...seenIds];
  const deleteCondition = seenArray.length > 0
    ? notInArray(recurringOrders.bexioOrderId, seenArray)
    : sql`true`; // if bexio returns zero orders, wipe everything (rare)
  const deleted = await db.delete(recurringOrders).where(deleteCondition).returning({ id: recurringOrders.bexioOrderId });
  removedOrders = deleted.length;

  return { total: orders.length, newlyAdded, alreadyTracked, removedOrders, newOrders, unsupportedOrders };
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
