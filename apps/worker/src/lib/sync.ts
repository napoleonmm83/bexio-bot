// Sync bexio recurring orders into the local recurring_orders cache.
// Rule: new orders inserted with enabled=false (Marcus opts in via dashboard).
// Existing orders preserve their enabled flag.

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { recurringOrders, getSetting, setSetting } from '@bexio-bot/db';
import {
  listRecurringOrders,
  listRecurringOrdersSince,
  getOrder,
  getOrderRepetition,
  getContact,
  formatContactName,
  mapBexioStatus,
  mapRepetitionToInterval,
  isSupportedBexioInterval,
  BexioApiError,
  type BexioOrder,
  type CanonicalInterval,
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
  /** Orders whose frozen billing address diverges from the live contact address
   *  (the order path inherits the frozen one). Detect-and-flag only — never
   *  auto-changed; a reused contact_id could otherwise mis-attribute the invoice. */
  driftWarnings: Array<{ bexioOrderId: number; customerName: string; detail: string }>;
};

const WATERMARK_KEY = 'last_incremental_sync_at';

/** bexio timestamp 'YYYY-MM-DD HH:mm:ss'. The incremental floor subtracts a 6h
 *  buffer (see syncRecurringOrders) which is the LOAD-BEARING safety margin —
 *  it dwarfs the max ~2h CH/UTC offset so a UTC-formatted floor can never miss a
 *  changed order. Do not shrink that buffer. Over-scan is harmless (idempotent upsert). */
function formatBexioTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

type ContactCache = Map<number, { name: string; email: string | null; postcode: string | null; city: string | null }>;

type MappedOrderRow = {
  interval: CanonicalInterval;
  intervalMultiplier: number;
  nextBillingDate: Date;
  customerName: string;
  customerEmail: string | null;
  bexioStatus: ReturnType<typeof mapBexioStatus>;
  repetitionFetchOk: boolean;
  unsupportedType: string | undefined;
  driftWarning: string | undefined;
};

/**
 * Map one bexio order to recurring_orders fields (repetition + contact + status).
 * Shared by full sync, incremental sync, and single-order import. Fetches the
 * repetition config (separate endpoint) and the contact (cached per run).
 */
async function buildOrderRow(
  accessToken: string,
  o: BexioOrder,
  contactCache: ContactCache,
): Promise<MappedOrderRow> {
  let interval: CanonicalInterval;
  let intervalMultiplier = 1;
  let nextBillingDate: Date;
  let unsupportedType: string | undefined;
  let repetitionFetchOk = true;
  try {
    const rep = await getOrderRepetition(accessToken, o.id);
    interval = mapRepetitionToInterval(rep);
    const rawInterval = rep?.repetition?.interval;
    intervalMultiplier = typeof rawInterval === 'number' && rawInterval >= 1 ? rawInterval : 1;
    const nb = computeNextBilling(rep);
    nextBillingDate = nb ?? new Date();
    if (!isSupportedBexioInterval(rep)) {
      unsupportedType = rep?.repetition?.type ?? 'unknown';
    } else if (nb === null) {
      // Supported type but unparseable schedule (e.g. weekly without weekdays).
      // Billing stays safe — the due-gate also returns null — but surface it so
      // the row doesn't silently read as "due now".
      unsupportedType = `${rep?.repetition?.type ?? 'unknown'} (Konfiguration unklar)`;
    }
  } catch {
    repetitionFetchOk = false;
    interval = 'monthly';
    nextBillingDate = new Date();
  }

  let cached = contactCache.get(o.contact_id);
  if (!cached) {
    try {
      const contact = await getContact(accessToken, o.contact_id);
      cached = {
        name: formatContactName(contact),
        email: contact.mail ?? null,
        postcode: contact.postcode ?? null,
        city: contact.city ?? null,
      };
    } catch {
      // bexio errored fetching the contact; fall back to order metadata.
      cached = { name: o.title || `Auftrag #${o.document_nr}`, email: null, postcode: null, city: null };
    }
    contactCache.set(o.contact_id, cached);
  }

  // Address-drift heuristic: the order freezes a free-text contact_address. If the
  // live contact's postcode no longer appears in it, the billing address drifted.
  // Postcodes are specific → low false-positive. Flag only; never auto-change (a
  // reused contact_id could otherwise mis-attribute the invoice).
  let driftWarning: string | undefined;
  const frozen = (o.contact_address ?? '').toLowerCase();
  if (frozen && cached.postcode) {
    const pc = cached.postcode.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Whole-token match so a postcode isn't matched inside a longer digit run
    // (e.g. '8000' must not match inside '80001' or a phone number).
    const present = new RegExp(`(?<!\\d)${pc}(?!\\d)`).test(frozen);
    if (!present) {
      driftWarning = `Kontakt jetzt: ${cached.postcode}${cached.city ? ` ${cached.city}` : ''}`;
    }
  }

  return {
    interval,
    intervalMultiplier,
    nextBillingDate,
    customerName: cached.name,
    customerEmail: cached.email,
    bexioStatus: mapBexioStatus(o.kb_item_status_id),
    repetitionFetchOk,
    unsupportedType,
    driftWarning,
  };
}

export type SyncMode = 'full' | 'incremental';

export async function syncRecurringOrders(
  db: Db,
  accessToken: string,
  options: { dryRun?: boolean; mode?: SyncMode } = {},
): Promise<SyncResult> {
  const mode: SyncMode = options.mode ?? 'full';
  const runStart = new Date();

  // INCREMENTAL: only orders changed since the watermark (minus a 6h safety
  // buffer for clock/tz skew). NO orphan cleanup — the changed-set is a subset,
  // so notInArray would wrongly wipe every untouched (and enabled!) order.
  // FULL: list all recurring orders and run orphan cleanup.
  let orders: BexioOrder[];
  if (mode === 'incremental') {
    const raw = await getSetting(db, WATERMARK_KEY);
    const base = raw ? new Date(raw) : new Date(runStart.getTime() - 7 * 86_400_000);
    const floor = new Date(base.getTime() - 6 * 3_600_000);
    orders = await listRecurringOrdersSince(accessToken, formatBexioTimestamp(floor));
  } else {
    orders = await listRecurringOrders(accessToken);
  }

  let newlyAdded = 0;
  let alreadyTracked = 0;
  const newOrders: SyncResult['newOrders'] = [];
  const unsupportedOrders: SyncResult['unsupportedOrders'] = [];
  const driftWarnings: SyncResult['driftWarnings'] = [];
  const seenIds = new Set<number>();

  // Cache contacts so two orders from the same customer don't trigger two API calls
  const contactCache: ContactCache = new Map();

  for (const o of orders) {
    seenIds.add(o.id);
    const { interval, intervalMultiplier, nextBillingDate, customerName, customerEmail, bexioStatus, repetitionFetchOk, unsupportedType, driftWarning } =
      await buildOrderRow(accessToken, o, contactCache);
    if (driftWarning) {
      driftWarnings.push({ bexioOrderId: o.id, customerName, detail: driftWarning });
    }

    if (options.dryRun) {
      // N-11: dry-run must not mutate state. Treat unknown orders as 'newly
      // added' for reporting only.
      newOrders.push({ bexioOrderId: o.id, customerName, interval });
      newlyAdded += 1;
      if (unsupportedType) {
        unsupportedOrders.push({ bexioOrderId: o.id, customerName, bexioType: unsupportedType });
      }
      continue;
    }

    // INSERT ... ON CONFLICT — if row exists, refresh cache fields incl. status.
    // Never touch `enabled` — that's the user's opt-in; auto-discovery (sync)
    // always lands disabled. (Only importOrderById may force-enable.)
    const result = await db
      .insert(recurringOrders)
      .values({
        bexioOrderId: o.id,
        customerId: o.contact_id,
        customerName,
        customerEmail,
        interval,
        intervalMultiplier,
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
          customerEmail,
          interval,
          intervalMultiplier,
          expectedAmount: o.total,
          // Preserve existing nextBillingDate if repetition fetch failed —
          // overwriting with today would corrupt a previously-good value. (F-10)
          ...(repetitionFetchOk ? { nextBillingDate } : {}),
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

  // Orphan cleanup — FULL mode only. Incremental sees a changed subset, so
  // notInArray would delete everything untouched.
  let removedOrders = 0;
  if (mode === 'full' && !options.dryRun) {
    const seenArray = [...seenIds];
    if (seenArray.length === 0) {
      // bexio returned zero recurring orders. Almost certainly a transient API
      // issue, not "Marcus deleted everything". Skip — wiping would lose all
      // opt-in enabled flags. (F-7)
      console.warn('sync: bexio returned zero recurring orders — skipping orphan cleanup to protect cache');
    } else {
      const deleted = await db
        .delete(recurringOrders)
        .where(notInArray(recurringOrders.bexioOrderId, seenArray))
        .returning({ id: recurringOrders.bexioOrderId });
      removedOrders = deleted.length;
    }
  } else if (options.dryRun) {
    console.log('sync: dry-run mode — skipping orphan cleanup (N-11)');
  }

  // Advance the incremental watermark to this run's start; next run picks up
  // anything changed after. Skipped in dry-run.
  if (mode === 'incremental' && !options.dryRun) {
    await setSetting(db, WATERMARK_KEY, runStart.toISOString());
  }

  return { total: orders.length, newlyAdded, alreadyTracked, removedOrders, newOrders, unsupportedOrders, driftWarnings };
}

export type ImportOrderResult =
  | { kind: 'imported'; bexioOrderId: number; customerName: string; interval: CanonicalInterval; enabled: boolean; wasInsert: boolean; unsupportedType?: string }
  | { kind: 'not_recurring'; bexioOrderId: number; customerName: string }
  | { kind: 'not_found'; bexioOrderId: number }
  | { kind: 'error'; bexioOrderId: number; message: string };

/**
 * Import a single bexio order on demand (manual). Fetches just that order + its
 * repetition and upserts one row — independent of a billing run. When `enable`
 * is true the row is activated immediately (an explicit, deliberate user
 * action); otherwise it lands disabled like auto-discovery. Sync never
 * auto-enables — only this path may.
 */
export async function importOrderById(
  db: Db,
  accessToken: string,
  orderId: number,
  opts: { enable?: boolean } = {},
): Promise<ImportOrderResult> {
  let order: BexioOrder;
  try {
    order = await getOrder(accessToken, orderId);
  } catch (err) {
    if (err instanceof BexioApiError && err.status === 404) {
      return { kind: 'not_found', bexioOrderId: orderId };
    }
    return { kind: 'error', bexioOrderId: orderId, message: err instanceof Error ? err.message : String(err) };
  }

  const contactCache: ContactCache = new Map();
  const row = await buildOrderRow(accessToken, order, contactCache);

  if (!order.is_recurring) {
    return { kind: 'not_recurring', bexioOrderId: orderId, customerName: row.customerName };
  }

  const enabled = opts.enable === true;
  const result = await db
    .insert(recurringOrders)
    .values({
      bexioOrderId: order.id,
      customerId: order.contact_id,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      interval: row.interval,
      intervalMultiplier: row.intervalMultiplier,
      expectedAmount: order.total,
      nextBillingDate: row.nextBillingDate,
      enabled,
      bexioStatus: row.bexioStatus,
      bexioStatusId: order.kb_item_status_id ?? null,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recurringOrders.bexioOrderId,
      set: {
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        interval: row.interval,
        intervalMultiplier: row.intervalMultiplier,
        expectedAmount: order.total,
        ...(row.repetitionFetchOk ? { nextBillingDate: row.nextBillingDate } : {}),
        // Explicit user action: force the enabled state (unlike sync).
        enabled,
        bexioStatus: row.bexioStatus,
        bexioStatusId: order.kb_item_status_id ?? null,
        syncedAt: new Date(),
      },
    })
    .returning({ inserted: sql<boolean>`xmax = 0` });

  return {
    kind: 'imported',
    bexioOrderId: order.id,
    customerName: row.customerName,
    interval: row.interval,
    enabled,
    wasInsert: result[0]?.inserted ?? false,
    unsupportedType: row.unsupportedType,
  };
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

export async function getProcessableOrderById(db: Db, bexioOrderId: number) {
  return db
    .select()
    .from(recurringOrders)
    .where(
      and(
        eq(recurringOrders.bexioOrderId, bexioOrderId),
        inArray(recurringOrders.bexioStatus, ['open', 'partial']),
      ),
    );
}
