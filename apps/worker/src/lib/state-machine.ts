// Per-order state machine for one cron run.
// Ansatz A: bexio decides when an order is due. We POST /kb_order/{id}/repetition
// for every enabled order and let bexio respond with either a created invoice or a
// "not due" error.
//
// State transitions (after the initial POST):
//
//   created → issuing → issued → sending → sent (terminal)
//                                                ↑
//                                             happy path
//
//   error at any step → failed (terminal, manual review)
//
// Idempotency: the (order_id, billing_period) PK on invoice_runs prevents duplicate
// processing within the same period. If bexio ever returns an invoice with a period
// we already have a row for, we trust the existing row and skip — never overwrite.
//
// Crash recovery: rows with status='sending' AND lock_acquired_at < now()-5min
// are reconciled via GET /kb_invoice/{id} — see reconcileInFlightSends().

import { and, eq, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { invoiceRuns, recurringOrders } from '@bexio-bot/db';
import {
  createInvoiceFromOrder,
  createInvoiceFromOrderSnapshot,
  issueInvoice,
  sendInvoice,
  getInvoice,
  getOrderRepetition,
  isSupportedBexioInterval,
  BexioApiError,
  type BexioInvoice,
  type BexioOrderRepetition,
} from '@bexio-bot/bexio-client';
import { formatBillingPeriod } from './billing-period.ts';
import { isOrderDue } from './next-billing.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

const MAX_ATTEMPTS = 3;
const LOCK_STALE_MS = 5 * 60 * 1000;

// Catch-up tolerance for the due-gate: an order is billed on its scheduled
// occurrence day and for this many days after (covers a skipped daily run).
// Never back-bills older periods. Override via env for tuning.
const DUE_WINDOW_DAYS = (() => {
  const raw = Number(process.env.ORDER_DUE_WINDOW_DAYS ?? '3');
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
})();

export type ProcessOrderResult =
  | { kind: 'sent'; invoiceId: number; amount: string; billingPeriod: string }
  | { kind: 'not_due'; reason: string }
  | { kind: 'skipped_duplicate'; existingInvoiceId: number; billingPeriod: string }
  | { kind: 'skipped_unsupported'; bexioType: string }
  | { kind: 'failed'; reason: string; bexioStatus?: number; invoiceId?: number };

export type OrderInput = {
  bexioOrderId: number;
  customerName: string;
  /** Used as recipient_email for /send. If null, /send fails with a clear error. */
  customerEmail: string | null;
};

const MAIL_SUBJECT_TEMPLATE = 'Rechnung {document_nr}';
const MAIL_MESSAGE_TEMPLATE = [
  'Sehr geehrte Damen und Herren',
  '',
  'Im Anhang finden Sie unsere Rechnung {document_nr}.',
  'Die Rechnung können Sie auch online einsehen: [Network Link]',
  '',
  'Bei Fragen stehen wir Ihnen gerne zur Verfügung.',
  '',
  'Freundliche Grüsse',
].join('\n');

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function todayIsoInZurich(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not format current Zurich date');
  return `${year}-${month}-${day}`;
}

function isFullyInvoicedOrderError(err: BexioApiError): boolean {
  return err.status === 422 && err.body.toLowerCase().includes('order is fully invoiced');
}

/**
 * Snapshot fallback is ONLY safe for daily / weekly recurring orders. For
 * monthly+ orders, bexio's 422 "order is fully invoiced" means "not yet due
 * this period" — snapshotting would create a non-due invoice (money loss /
 * overbilling). For daily / weekly the snapshot path is correct because the
 * order's positions are exhausted by the first invoice and bexio rejects every
 * subsequent same-period call.
 */
export function shouldSnapshotFallback(repetitionType: string | undefined): boolean {
  return repetitionType === 'daily' || repetitionType === 'weekly';
}

export type ClaimResult =
  | { kind: 'own' }
  | { kind: 'duplicate'; existingInvoiceId: number; billingPeriod: string }
  | { kind: 'concurrent-in-flight' };

/**
 * Interpret the result of an INSERT-with-ON-CONFLICT claim attempt:
 *   - inserted has rows → we won the claim, slot is ours
 *   - inserted empty + existing has invoice_id → another run already finished this slot (real duplicate)
 *   - inserted empty + existing has no invoice_id → another run is mid-flight on this slot (concurrent)
 */
export function interpretClaimResult(
  inserted: Array<{ orderId: number; status: string; invoiceId: number | null }>,
  existing: { orderId: number; invoiceId: number | null; billingPeriod: string; status?: string } | null,
): ClaimResult {
  if (inserted.length > 0) return { kind: 'own' };
  if (existing?.invoiceId != null) {
    return { kind: 'duplicate', existingInvoiceId: existing.invoiceId, billingPeriod: existing.billingPeriod };
  }
  return { kind: 'concurrent-in-flight' };
}

/**
 * Drive one order through the full pipeline in this run.
 * Single API "round trip" per state — no nested locking, transactions are
 * narrow around the DB writes.
 */
export async function processOrder(
  db: Db,
  accessToken: string,
  order: OrderInput,
): Promise<ProcessOrderResult> {
  const invoiceDate = todayIsoInZurich();

  // Step 0: fetch repetition — REQUIRED for billing-period granularity. We
  // retry once before giving up. Silent fallback to monthly is unsafe because
  // a later successful fetch would use a different period key for the same
  // logical day, allowing duplicate invoices. (N-3)
  let repetitionType: string | undefined;
  let repetition: BexioOrderRepetition | undefined;
  let repetitionFetchSucceeded = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rep = await getOrderRepetition(accessToken, order.bexioOrderId);
      if (!isSupportedBexioInterval(rep)) {
        console.log(`[order=${order.bexioOrderId}] unsupported bexio repetition type "${rep?.repetition?.type ?? 'unknown'}" — skipping`);
        return {
          kind: 'skipped_unsupported',
          bexioType: rep?.repetition?.type ?? 'unknown',
        };
      }
      repetition = rep;
      repetitionType = rep?.repetition?.type;
      repetitionFetchSucceeded = true;
      break;
    } catch (err) {
      if (attempt === 1) {
        console.error(`[order=${order.bexioOrderId}] getOrderRepetition failed after 2 attempts:`, err);
      }
    }
  }
  if (!repetitionFetchSucceeded) {
    return {
      kind: 'failed',
      reason: 'could not fetch repetition config from bexio after 2 attempts — refusing to process to avoid split-brain period keys',
    };
  }

  // Due-gate: bexio's POST /kb_order/{id}/invoice is NOT a recurrence trigger —
  // it bills on demand regardless of the schedule — so the bot must decide
  // due-ness itself. An order is due only on its scheduled occurrence day (plus
  // a small catch-up window for skipped runs); it never back-bills older
  // periods. Without this gate every enabled monthly/yearly order was billed on
  // the first run after activation, and orders onboarded with an old start date
  // would have their last past period billed immediately. (daily only "worked"
  // by coincidence — it's due every day.)
  const dueOccurrence = isOrderDue(repetition, new Date(), DUE_WINDOW_DAYS);
  if (!dueOccurrence) {
    console.log(`[order=${order.bexioOrderId}] not due today (window=${DUE_WINDOW_DAYS}d) — next scheduled occurrence is in the future`);
    return {
      kind: 'not_due',
      reason: `not due today — next scheduled occurrence is in the future (catch-up window ${DUE_WINDOW_DAYS}d)`,
    };
  }

  // Anchor the billing_period key to the occurrence date, not the run date, so
  // the (order_id, billing_period) dedup tracks the real schedule: one invoice
  // per occurrence, robust to a run that fires a few days into the period.
  const occurrenceIso = dueOccurrence.toISOString();
  let billingPeriod = formatBillingPeriod(occurrenceIso, repetitionType);
  // Stable prefix on every log line — pipe Coolify logs through `grep "[order=N"`
  // to follow one order's full pipeline. Keep prefix short; the orchestrator's
  // summary already shows the customer name.
  const ctx = `[order=${order.bexioOrderId} period=${billingPeriod}]`;

  // Claim the slot atomically (F-3, N-10). INSERT with status='creating' acts
  // as a DB-level lock; if it succeeds we own the slot and the bexio call is
  // safe. If it fails, either someone else already finished (duplicate) or is
  // mid-flight (concurrent). This prevents two parallel triggers from each
  // POSTing to bexio and forgetting one of the resulting invoice IDs.
  const claimInsert = await db
    .insert(invoiceRuns)
    .values({
      orderId: order.bexioOrderId,
      billingPeriod,
      status: 'creating',
      attempts: 1,
    })
    .onConflictDoNothing({ target: [invoiceRuns.orderId, invoiceRuns.billingPeriod] })
    .returning({ orderId: invoiceRuns.orderId, status: invoiceRuns.status, invoiceId: invoiceRuns.invoiceId });

  const existingRow = claimInsert.length === 0
    ? (await db
        .select()
        .from(invoiceRuns)
        .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod))))[0] ?? null
    : null;

  const claim = interpretClaimResult(claimInsert, existingRow);

  if (claim.kind === 'duplicate') {
    console.log(`${ctx} duplicate guard hit — existing invoice ${claim.existingInvoiceId}`);
    return {
      kind: 'skipped_duplicate',
      existingInvoiceId: claim.existingInvoiceId,
      billingPeriod: claim.billingPeriod,
    };
  }
  if (claim.kind === 'concurrent-in-flight') {
    console.log(`${ctx} concurrent run in-flight on same period — backing off`);
    return { kind: 'not_due', reason: 'concurrent run in progress; try again later' };
  }
  // claim.kind === 'own' — proceed

  // Step 1: ask bexio to create the next invoice
  let invoice: BexioInvoice | undefined;
  try {
    invoice = await createInvoiceFromOrder(accessToken, { order_id: order.bexioOrderId });
    console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → invoice ${invoice.id}`);
  } catch (err) {
    if (err instanceof BexioApiError) {
      if (isFullyInvoicedOrderError(err)) {
        if (!shouldSnapshotFallback(repetitionType)) {
          console.log(`${ctx} 422 fully-invoiced on ${repetitionType ?? 'unknown'} order — treating as not_due (snapshot only allowed for daily/weekly)`);
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return {
            kind: 'not_due',
            reason: `422 fully-invoiced (${repetitionType ?? 'unknown'} not-due-this-period; snapshot only allowed for daily/weekly)`,
          };
        }
        console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → 422 fully-invoiced on daily/weekly; trying snapshot fallback`);
        try {
          invoice = await createInvoiceFromOrderSnapshot(accessToken, {
            orderId: order.bexioOrderId,
            isValidFrom: invoiceDate,
            apiReference: `bexio-bot:order:${order.bexioOrderId}:period:${billingPeriod}`,
          });
          console.log(`${ctx} snapshot fallback → invoice ${invoice.id}`);
        } catch (fallbackErr) {
          if (fallbackErr instanceof BexioApiError) {
            console.error(`${ctx} snapshot fallback FAILED status=${fallbackErr.status} class=${fallbackErr.errorClass} body=${fallbackErr.body}`);
          } else {
            console.error(`${ctx} snapshot fallback FAILED (non-BexioApiError):`, fallbackErr);
          }
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return {
            kind: 'failed',
            reason: fallbackErr instanceof BexioApiError
              ? `snapshot fallback failed: ${fallbackErr.errorClass}: ${fallbackErr.body.slice(0, 800)}`
              : `snapshot fallback failed: ${String(fallbackErr)}`,
            bexioStatus: fallbackErr instanceof BexioApiError ? fallbackErr.status : undefined,
          };
        }
      } else {
        // 403 = scope mismatch or permission denied.
        if (err.status === 403) {
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return {
            kind: 'failed',
            reason: `scope/permission denied — bexio 403: ${err.body.slice(0, 150)}. Likely missing kb_order_edit scope; re-auth needed.`,
            bexioStatus: 403,
          };
        }
        if (err.status === 401) {
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return {
            kind: 'failed',
            reason: `token invalid — bexio 401. Run bun run oauth-setup to re-auth.`,
            bexioStatus: 401,
          };
        }
        if (err.errorClass === 'permanent') {
          console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → ${err.status} permanent (treated as not_due): ${err.body.slice(0, 300)}`);
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return { kind: 'not_due', reason: err.body.slice(0, 200) };
        }
        console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED status=${err.status} class=${err.errorClass} body=${err.body}`);
      }
    } else {
      console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED (non-BexioApiError):`, err);
    }
    if (!invoice) {
      await deleteClaim(db, order.bexioOrderId, billingPeriod);
      return {
        kind: 'failed',
        reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err),
        bexioStatus: err instanceof BexioApiError ? err.status : undefined,
      };
    }
  }
  if (!invoice) {
    await deleteClaim(db, order.bexioOrderId, billingPeriod);
    return { kind: 'failed', reason: 'invoice creation returned no invoice' };
  }

  // Bexio call succeeded — reconcile period key from invoice.is_valid_from
  // (N-2). bexio may set a different date than today (e.g., schedule shift),
  // and the period it logically belongs to is the one derived from that date.
  const invoiceValidFrom = invoice.is_valid_from ?? invoiceDate;
  const truePeriod = formatBillingPeriod(invoiceValidFrom, repetitionType);
  if (truePeriod !== billingPeriod) {
    console.log(`${ctx} migrating period key ${billingPeriod} → ${truePeriod} (from invoice is_valid_from=${invoiceValidFrom})`);
    await db
      .update(invoiceRuns)
      .set({ billingPeriod: truePeriod, invoiceId: invoice.id, status: 'created', updatedAt: new Date() })
      .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
    billingPeriod = truePeriod;
  } else {
    await db
      .update(invoiceRuns)
      .set({ invoiceId: invoice.id, status: 'created', updatedAt: new Date() })
      .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
  }

  // Step 3: drive through issuing → issued → sending → sent
  // wasIssued tracks whether issueInvoice() succeeded so we can roll back to
  // 'issued' (not 'failed') on send errors — letting retryIssuedRows pick the
  // row up next run instead of marking it terminally failed. (F-2)
  let wasIssued = false;
  try {
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issuing');
    await issueInvoice(accessToken, invoice.id);
    console.log(`${ctx} issued invoice ${invoice.id} (${invoice.document_nr})`);
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issued', { issuedAt: new Date() });
    wasIssued = true;

    if (!order.customerEmail) {
      // Can't send without an email. Throw a plain Error (F-9 — was BexioApiError(0)).
      // wasIssued=true at this point, so the catch will leave status='issued' for
      // the next run to pick up via retryIssuedRows once Marcus fixes the contact.
      throw new Error(`No customer email for ${order.customerName}. Update the contact in bexio.`);
    }

    const docNr = invoice.document_nr;
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'sending', {
      lockAcquiredAt: new Date(),
    });
    await sendInvoice(accessToken, invoice.id, {
      recipientEmail: order.customerEmail,
      subject: renderTemplate(MAIL_SUBJECT_TEMPLATE, { document_nr: docNr }),
      message: renderTemplate(MAIL_MESSAGE_TEMPLATE, { document_nr: docNr }),
      attachPdf: true,
    });
    console.log(`${ctx} sent invoice ${invoice.id} to ${order.customerEmail}`);
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'sent', {
      sentAt: new Date(),
      lockAcquiredAt: null,
    });

    return { kind: 'sent', invoiceId: invoice.id, amount: invoice.total, billingPeriod };
  } catch (err) {
    if (err instanceof BexioApiError) {
      console.error(`${ctx} issue/send FAILED invoice=${invoice.id} status=${err.status} class=${err.errorClass} body=${err.body}`);
    } else {
      console.error(`${ctx} issue/send FAILED invoice=${invoice.id}:`, err);
    }

    if (wasIssued) {
      // Invoice is festgeschrieben in bexio. Don't mark failed — let
      // retryIssuedRows pick it up on the next run. Persist the error to
      // error_jsonb for visibility but keep status='issued'. (F-2)
      const errorJsonb =
        err instanceof BexioApiError
          ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500), at: 'send' as const }
          : { kind: 'unknown' as const, message: err instanceof Error ? err.message : String(err), at: 'send' as const };
      await db
        .update(invoiceRuns)
        .set({ status: 'issued', errorJsonb, lockAcquiredAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
      return {
        kind: 'failed',
        reason: `send failed but invoice ${invoice.id} is issued — will retry next run: ${err instanceof Error ? err.message : String(err)}`,
        bexioStatus: err instanceof BexioApiError ? err.status : undefined,
        invoiceId: invoice.id,
      };
    }

    // Issue itself failed — mark fully failed.
    await markFailed(db, order.bexioOrderId, billingPeriod, err);
    return {
      kind: 'failed',
      reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err),
      bexioStatus: err instanceof BexioApiError ? err.status : undefined,
      invoiceId: invoice.id,
    };
  }
}

async function deleteClaim(db: Db, orderId: number, billingPeriod: string): Promise<void> {
  await db
    .delete(invoiceRuns)
    .where(and(eq(invoiceRuns.orderId, orderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
}

async function transitionTo(
  db: Db,
  orderId: number,
  billingPeriod: string,
  status: 'issuing' | 'issued' | 'sending' | 'sent',
  extra: Partial<{ issuedAt: Date; sentAt: Date; lockAcquiredAt: Date | null }> = {},
): Promise<void> {
  await db
    .update(invoiceRuns)
    .set({
      status,
      updatedAt: new Date(),
      ...(extra.issuedAt !== undefined ? { issuedAt: extra.issuedAt } : {}),
      ...(extra.sentAt !== undefined ? { sentAt: extra.sentAt } : {}),
      ...(extra.lockAcquiredAt !== undefined ? { lockAcquiredAt: extra.lockAcquiredAt } : {}),
    })
    .where(and(eq(invoiceRuns.orderId, orderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
}

async function markFailed(db: Db, orderId: number, billingPeriod: string, err: unknown): Promise<void> {
  const errorJsonb =
    err instanceof BexioApiError
      ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500) }
      : { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };

  await db
    .update(invoiceRuns)
    .set({
      status: 'failed',
      errorJsonb,
      updatedAt: new Date(),
    })
    .where(and(eq(invoiceRuns.orderId, orderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
}

/**
 * Crash recovery: find rows in mid-flight whose lock has gone stale.
 * For each, ask bexio if the invoice was actually sent. Resolve accordingly.
 *
 * Run this BEFORE processing new orders in each cron run.
 */
export async function reconcileInFlightSends(db: Db, accessToken: string): Promise<{
  reconciledSent: number;
  reconciledIssued: number;
  reconciledFailed: number;
}> {
  const cutoff = new Date(Date.now() - LOCK_STALE_MS);

  const stuck = await db
    .select()
    .from(invoiceRuns)
    .where(
      and(
        eq(invoiceRuns.status, 'sending'),
        lt(invoiceRuns.lockAcquiredAt, cutoff),
      ),
    );

  let reconciledSent = 0;
  let reconciledIssued = 0;
  let reconciledFailed = 0;

  for (const row of stuck) {
    if (!row.invoiceId) {
      reconciledFailed += 1;
      await markFailed(db, row.orderId, row.billingPeriod, new Error('crash_during_send_no_invoice_id'));
      continue;
    }

    try {
      const live = await getInvoice(accessToken, row.invoiceId);
      if (live.is_sent || live.mail_sent_at) {
        // bexio confirms sent — trust it.
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: live.mail_sent_at ? new Date(live.mail_sent_at) : new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if ((row.attempts ?? 0) >= 1) {
        // bexio doesn't confirm sent, but we ALREADY tried at least once.
        // bexio's GET /kb_invoice/{id} is famously flaky here — is_sent may
        // stay undefined even after a successful /send (see invoices.ts:182).
        // Assume the send happened to avoid spamming the customer with
        // duplicate mails. If it really didn't go out, Marcus will notice
        // from a missing receipt and can re-trigger manually. (N-5)
        console.warn(
          `[reconcile order=${row.orderId} period=${row.billingPeriod}] bexio is_sent unconfirmed after ${row.attempts} attempts — assuming sent (bexio read-back quirk)`,
        );
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
        await markFailed(db, row.orderId, row.billingPeriod, new Error('send_retries_exhausted'));
        reconciledFailed += 1;
      } else {
        // attempts === 0 — claimed but never actually called send. Safe to retry.
        await db
          .update(invoiceRuns)
          .set({
            status: 'issued',
            lockAcquiredAt: null,
            attempts: sql`${invoiceRuns.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
        reconciledIssued += 1;
      }
    } catch (err) {
      await markFailed(db, row.orderId, row.billingPeriod, err);
      reconciledFailed += 1;
    }
  }

  return { reconciledSent, reconciledIssued, reconciledFailed };
}

/**
 * Retry rows in 'issued' state that didn't reach 'sent' (e.g. recovered from crash).
 *
 * Atomically claims ALL eligible rows in one UPDATE-RETURNING transition to
 * 'sending' + attempts++; concurrent workers won't see the same rows. (N-4)
 */
export async function retryIssuedRows(db: Db, accessToken: string): Promise<number> {
  const claimed = await db
    .update(invoiceRuns)
    .set({
      status: 'sending',
      lockAcquiredAt: new Date(),
      attempts: sql`${invoiceRuns.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(invoiceRuns.status, 'issued'), lt(invoiceRuns.attempts, MAX_ATTEMPTS)))
    .returning();

  let recovered = 0;

  for (const row of claimed) {
    if (!row.invoiceId) {
      await markFailed(db, row.orderId, row.billingPeriod, new Error('no_invoice_id_on_retry'));
      continue;
    }

    const orders = await db
      .select()
      .from(recurringOrders)
      .where(eq(recurringOrders.bexioOrderId, row.orderId));
    const order = orders[0];
    if (!order?.customerEmail) {
      await markFailed(db, row.orderId, row.billingPeriod, new Error('no_customer_email_on_retry'));
      continue;
    }

    try {
      const live = await getInvoice(accessToken, row.invoiceId);
      const docNr = live.document_nr;
      await sendInvoice(accessToken, row.invoiceId, {
        recipientEmail: order.customerEmail,
        subject: renderTemplate(MAIL_SUBJECT_TEMPLATE, { document_nr: docNr }),
        message: renderTemplate(MAIL_MESSAGE_TEMPLATE, { document_nr: docNr }),
        attachPdf: true,
      });
      await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
        sentAt: new Date(),
        lockAcquiredAt: null,
      });
      recovered += 1;
    } catch (err) {
      // We already bumped attempts during the claim. Roll back to 'issued' so
      // future runs can try again, unless this attempt was the last.
      if (row.attempts != null && row.attempts >= MAX_ATTEMPTS) {
        await markFailed(db, row.orderId, row.billingPeriod, err);
      } else {
        const errorJsonb =
          err instanceof BexioApiError
            ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500) }
            : { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
        await db
          .update(invoiceRuns)
          .set({ status: 'issued', lockAcquiredAt: null, errorJsonb, updatedAt: new Date() })
          .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
      }
    }
  }

  return recovered;
}
