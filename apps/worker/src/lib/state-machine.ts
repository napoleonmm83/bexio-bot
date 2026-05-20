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
} from '@bexio-bot/bexio-client';
import { formatBillingPeriod } from './billing-period.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

const MAX_ATTEMPTS = 3;
const LOCK_STALE_MS = 5 * 60 * 1000;

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
  const billingPeriod = formatBillingPeriod(invoiceDate);
  // Stable prefix on every log line — pipe Coolify logs through `grep "[order=N"`
  // to follow one order's full pipeline. Keep prefix short; the orchestrator's
  // summary already shows the customer name.
  const ctx = `[order=${order.bexioOrderId} period=${billingPeriod}]`;

  const existingForPeriod = await db
    .select()
    .from(invoiceRuns)
    .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
  if (existingForPeriod[0]?.invoiceId) {
    console.log(`${ctx} duplicate guard hit — existing invoice ${existingForPeriod[0].invoiceId}`);
    return {
      kind: 'skipped_duplicate',
      existingInvoiceId: existingForPeriod[0].invoiceId,
      billingPeriod,
    };
  }

  // Step 0: safety check — refuse to bill unsupported intervals (weekly/daily/custom).
  // Bot would otherwise create a monthly invoice for an order Marcus configured weekly.
  try {
    const rep = await getOrderRepetition(accessToken, order.bexioOrderId);
    if (!isSupportedBexioInterval(rep)) {
      console.log(`${ctx} unsupported bexio repetition type "${rep?.repetition?.type ?? 'unknown'}" — skipping`);
      return {
        kind: 'skipped_unsupported',
        bexioType: rep?.repetition?.type ?? 'unknown',
      };
    }
  } catch {
    // If we can't fetch repetition, fall through to bexio — it'll tell us via 4xx.
  }

  // Step 1: ask bexio to create the next invoice
  let invoice: BexioInvoice | undefined;
  try {
    invoice = await createInvoiceFromOrder(accessToken, { order_id: order.bexioOrderId });
    console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → invoice ${invoice.id}`);
  } catch (err) {
    if (err instanceof BexioApiError) {
      if (isFullyInvoicedOrderError(err)) {
        console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → 422 fully-invoiced; trying snapshot fallback`);
        try {
          invoice = await createInvoiceFromOrderSnapshot(accessToken, {
            orderId: order.bexioOrderId,
            isValidFrom: invoiceDate,
            apiReference: `bexio-bot:order:${order.bexioOrderId}:period:${billingPeriod}`,
          });
          console.log(`${ctx} snapshot fallback → invoice ${invoice.id}`);
        } catch (fallbackErr) {
          if (fallbackErr instanceof BexioApiError) {
            // Full body to console for Coolify logs / grep-ability. result.reason
            // gets a longer slice (800 chars) so Discord notify also surfaces the
            // bexio validation message instead of cutting off mid-error.
            console.error(`${ctx} snapshot fallback FAILED status=${fallbackErr.status} class=${fallbackErr.errorClass} body=${fallbackErr.body}`);
          } else {
            console.error(`${ctx} snapshot fallback FAILED (non-BexioApiError):`, fallbackErr);
          }
          return {
            kind: 'failed',
            reason: fallbackErr instanceof BexioApiError
              ? `snapshot fallback failed: ${fallbackErr.errorClass}: ${fallbackErr.body.slice(0, 800)}`
              : `snapshot fallback failed: ${String(fallbackErr)}`,
            bexioStatus: fallbackErr instanceof BexioApiError ? fallbackErr.status : undefined,
          };
        }
      } else {
      // 403 = scope mismatch or permission denied. Distinct from "not due".
      // Body usually mentions "not allowed" or "permission".
      if (err.status === 403) {
        return {
          kind: 'failed',
          reason: `scope/permission denied — bexio 403: ${err.body.slice(0, 150)}. Likely missing kb_order_edit scope; re-auth needed.`,
          bexioStatus: 403,
        };
      }
      // 401 = token invalid. Worker should refresh first, but the catch-net is here too.
      if (err.status === 401) {
        return {
          kind: 'failed',
          reason: `token invalid — bexio 401. Run bun run oauth-setup to re-auth.`,
          bexioStatus: 401,
        };
      }
      // 4xx-permanent that aren't auth: most likely "no repetition due" or
      // "invalid order state". Treat as not_due — recurring will retry tomorrow.
      // bexio's "not due" responses typically include phrases like "not_due",
      // "no repetition" or "nothing to invoice" — we don't pattern-match to keep
      // the heuristic loose; the differentiation 401/403 above catches the auth case.
      if (err.errorClass === 'permanent') {
        console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → ${err.status} permanent (treated as not_due): ${err.body.slice(0, 300)}`);
        return { kind: 'not_due', reason: err.body.slice(0, 200) };
      }
      console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED status=${err.status} class=${err.errorClass} body=${err.body}`);
      }
    } else {
      console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED (non-BexioApiError):`, err);
    }
    if (!invoice) return {
      kind: 'failed',
      reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err),
      bexioStatus: err instanceof BexioApiError ? err.status : undefined,
    };
  }
  if (!invoice) {
    return { kind: 'failed', reason: 'invoice creation returned no invoice' };
  }

  // Step 2: insert invoice_runs row. ON CONFLICT means bexio gave us an invoice for
  // a period we already processed — that's a duplicate. Skip and log.
  const inserted = await db
    .insert(invoiceRuns)
    .values({
      orderId: order.bexioOrderId,
      billingPeriod,
      invoiceId: invoice.id,
      status: 'created',
      attempts: 1,
    })
    .onConflictDoNothing({ target: [invoiceRuns.orderId, invoiceRuns.billingPeriod] })
    .returning({ orderId: invoiceRuns.orderId });

  if (inserted.length === 0) {
    // Already had a row for (order_id, billing_period). Read existing invoice_id.
    const existing = await db
      .select()
      .from(invoiceRuns)
      .where(
        and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)),
      );
    return {
      kind: 'skipped_duplicate',
      existingInvoiceId: existing[0]?.invoiceId ?? invoice.id,
      billingPeriod,
    };
  }

  // Step 3: drive through issuing → issued → sending → sent
  try {
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issuing');
    await issueInvoice(accessToken, invoice.id);
    console.log(`${ctx} issued invoice ${invoice.id} (${invoice.document_nr})`);
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issued', { issuedAt: new Date() });

    if (!order.customerEmail) {
      // Can't send without an email. Mark as failed so Marcus sees it and fixes
      // the contact's email in bexio. The invoice is festgeschrieben (issued), so
      // Marcus can also send it manually from bexio's UI.
      throw new BexioApiError(
        0,
        'permanent',
        `No customer email for ${order.customerName}. Update the contact in bexio.`,
      );
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
    await markFailed(db, order.bexioOrderId, billingPeriod, err);
    return {
      kind: 'failed',
      reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err),
      bexioStatus: err instanceof BexioApiError ? err.status : undefined,
      invoiceId: invoice.id,
    };
  }
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
      // No invoice_id but status='sending' is impossible by construction — log + skip.
      reconciledFailed += 1;
      await markFailed(db, row.orderId, row.billingPeriod, new Error('crash_during_send_no_invoice_id'));
      continue;
    }

    try {
      const live = await getInvoice(accessToken, row.invoiceId);
      if (live.is_sent || live.mail_sent_at) {
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: live.mail_sent_at ? new Date(live.mail_sent_at) : new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
        await markFailed(db, row.orderId, row.billingPeriod, new Error('send_retries_exhausted'));
        reconciledFailed += 1;
      } else {
        // Roll back to 'issued' so the next run retries the send. Bump attempts.
        await db
          .update(invoiceRuns)
          .set({
            status: 'issued',
            lockAcquiredAt: null,
            attempts: sql`${invoiceRuns.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(invoiceRuns.orderId, row.orderId),
              eq(invoiceRuns.billingPeriod, row.billingPeriod),
            ),
          );
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
 */
export async function retryIssuedRows(db: Db, accessToken: string): Promise<number> {
  const issued = await db.select().from(invoiceRuns).where(eq(invoiceRuns.status, 'issued'));
  let recovered = 0;

  for (const row of issued) {
    if (!row.invoiceId) continue;
    if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
      await markFailed(db, row.orderId, row.billingPeriod, new Error('send_retries_exhausted'));
      continue;
    }

    // Look up the order's customer email and document_nr for the send call
    const orders = await db
      .select()
      .from(recurringOrders)
      .where(eq(recurringOrders.bexioOrderId, row.orderId));
    const order = orders[0];
    if (!order?.customerEmail) {
      await markFailed(
        db,
        row.orderId,
        row.billingPeriod,
        new Error('no_customer_email_on_retry'),
      );
      continue;
    }

    try {
      await transitionTo(db, row.orderId, row.billingPeriod, 'sending', {
        lockAcquiredAt: new Date(),
      });
      // We don't have document_nr cached, so look it up
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
      await markFailed(db, row.orderId, row.billingPeriod, err);
    }
  }

  return recovered;
}
