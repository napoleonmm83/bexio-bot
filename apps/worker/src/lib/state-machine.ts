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

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { invoiceRuns, recurringOrders } from '@bexio-bot/db';
import {
  createInvoiceFromOrder,
  createInvoiceFromOrderSnapshot,
  issueInvoice,
  sendInvoice,
  getInvoice,
  findInvoiceByApiReference,
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

// Per-run config, resolved from app_settings (DB → env → default) in
// loadWorkerSettings() and threaded in. dueWindowDays = catch-up tolerance for
// the due-gate: an order is billed on its scheduled occurrence day and for this
// many days after (covers a skipped daily run); never back-bills older periods.
export type MailConfig = { mailSubject: string; mailMessage: string };
export type ProcessOrderConfig = MailConfig & { dueWindowDays: number; autoSend: boolean };

export type ProcessOrderResult =
  | { kind: 'sent'; invoiceId: number; amount: string; billingPeriod: string }
  | { kind: 'created_unsent'; invoiceId: number; amount: string; billingPeriod: string }
  // wasDue=true marks a not_due that happened even though the order WAS due this
  // run (a bexio error was swallowed) — as opposed to the order genuinely not
  // being scheduled. The run-level reconciliation (collectBillingAnomalies)
  // alerts on the former so a due-but-unbilled order can't pass silently.
  | { kind: 'not_due'; reason: string; wasDue?: boolean }
  | { kind: 'skipped_duplicate'; existingInvoiceId: number; billingPeriod: string }
  | { kind: 'skipped_unsupported'; bexioType: string }
  | { kind: 'failed'; reason: string; bexioStatus?: number; invoiceId?: number };

export type OrderInput = {
  bexioOrderId: number;
  customerName: string;
  /** Used as recipient_email for /send. If null, /send fails with a clear error. */
  customerEmail: string | null;
};

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function isoDateInZurich(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not format Zurich date');
  return `${year}-${month}-${day}`;
}

/**
 * A 422 from POST /kb_order/{id}/invoice meaning "this order can't be converted
 * to another invoice — its positions are already invoiced". bexio returns (at
 * least) two different messages for the same underlying state, depending on the
 * order:
 *   - "order is fully invoiced"
 *   - "the order does not contain any valid positions"
 * Both must route to the snapshot fallback (which re-copies the order's raw
 * positions). Matching only the first silently dropped the second → the order
 * fell through to errorClass='permanent' → not_due, and monthly order #5 was
 * never re-billed. Fail-closed: any other 422 stays a real error.
 */
export function isOrderExhaustedError(err: BexioApiError): boolean {
  if (err.status !== 422) return false;
  const b = err.body.toLowerCase();
  return b.includes('order is fully invoiced') || b.includes('does not contain any valid positions');
}

/**
 * On a 422 "order is fully invoiced", fall back to a snapshot invoice for EVERY
 * supported recurring type. bexio's POST /kb_order/{id}/invoice succeeds exactly
 * once — after the first invoice the order's positions are exhausted and every
 * later call returns 422 — so without a fallback an order bills only once.
 *
 * This used to be gated to daily/weekly only, on the assumption that a 422 on a
 * monthly+ order meant "not yet due this period" and snapshotting would overbill.
 * That was wrong: it silently skipped every occurrence after the first, so
 * monthly / quarterly / semi-annual / yearly orders (bexio type 'monthly' with
 * interval 1/3/6, or 'yearly') billed exactly ONCE and then never again.
 *
 * The overbilling fear is already handled upstream: by the time this runs,
 * processOrder has gated on isOrderDue (only a genuinely-due occurrence gets
 * here, added 2026-05-30) AND won the (order_id, billing_period) claim (dedup:
 * one invoice per occurrence). So a snapshot can only ever fire for a due,
 * not-yet-billed period. Fail-closed on unknown/unsupported types.
 */
export function shouldSnapshotFallback(repetitionType: string | undefined): boolean {
  return (
    repetitionType === 'daily' ||
    repetitionType === 'weekly' ||
    repetitionType === 'monthly' ||
    repetitionType === 'yearly'
  );
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
  config: ProcessOrderConfig,
): Promise<ProcessOrderResult> {
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
  const dueOccurrence = isOrderDue(repetition, new Date(), config.dueWindowDays);
  if (!dueOccurrence) {
    console.log(`[order=${order.bexioOrderId}] not due today (window=${config.dueWindowDays}d) — next scheduled occurrence is in the future`);
    return {
      kind: 'not_due',
      reason: `not due today — next scheduled occurrence is in the future (catch-up window ${config.dueWindowDays}d)`,
    };
  }

  // Anchor the billing_period key to the occurrence date, not the run date, so
  // the (order_id, billing_period) dedup tracks the real schedule: one invoice
  // per occurrence, robust to a run that fires a few days into the period.
  const occurrenceIso = dueOccurrence.toISOString();
  // Anchor the snapshot invoice's is_valid_from to the OCCURRENCE day (not the
  // run day). Otherwise a daily/weekly order billed 1–3 days late inside the
  // catch-up window would get is_valid_from=today, and the post-create period
  // reconciliation (below) would migrate its key off the schedule.
  const occurrenceDate = isoDateInZurich(dueOccurrence);
  const billingPeriod = formatBillingPeriod(occurrenceIso, repetitionType);
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
      // BUG-2: attempts counts SEND attempts, not claim existence. Start at 0;
      // it is bumped to 1 right before sendInvoice. Crash recovery relies on
      // attempts===0 to mean "claimed/issued but send never attempted" → retry.
      attempts: 0,
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
  // True when the snapshot guard reused an EXISTING (not-yet-sent) bexio invoice
  // instead of creating one. Such an invoice may already be festgeschrieben, so
  // the issue step below tolerates an "already issued" error.
  let reusedUnsent = false;
  try {
    invoice = await createInvoiceFromOrder(accessToken, { order_id: order.bexioOrderId });
    console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → invoice ${invoice.id}`);
  } catch (err) {
    if (err instanceof BexioApiError) {
      if (isOrderExhaustedError(err)) {
        if (!shouldSnapshotFallback(repetitionType)) {
          console.log(`${ctx} 422 order-exhausted on unsupported type "${repetitionType ?? 'unknown'}" — treating as not_due (no snapshot fallback)`);
          await deleteClaim(db, order.bexioOrderId, billingPeriod);
          return {
            kind: 'not_due',
            wasDue: true,
            reason: `422 order-exhausted on unsupported type "${repetitionType ?? 'unknown'}" (no snapshot fallback)`,
          };
        }
        console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → 422 order-exhausted on ${repetitionType ?? 'unknown'}; trying snapshot fallback`);
        const apiRef = `bexio-bot:order:${order.bexioOrderId}:period:${billingPeriod}`;
        try {
          // API-side idempotency guard: a prior run may have created this invoice
          // in bexio but had its local DB claim rolled back. Reuse it instead of
          // creating a duplicate. (Snapshot path only — the order path sets no
          // api_reference, and bexio's own 422 guards it.)
          const existing = await findInvoiceByApiReference(accessToken, apiRef);
          if (existing && (existing.is_sent || existing.mail_sent_at)) {
            // The prior run already created AND sent this invoice. Reconcile the
            // local claim to 'sent' and do NOT re-issue/re-send — re-sending would
            // email the customer a duplicate (mirrors reconcileInFlightSends).
            await db
              .update(invoiceRuns)
              .set({
                invoiceId: existing.id,
                status: 'sent',
                sentAt: existing.mail_sent_at ? new Date(existing.mail_sent_at) : new Date(),
                lockAcquiredAt: null,
                updatedAt: new Date(),
              })
              .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
            console.log(`${ctx} snapshot: existing invoice ${existing.id} already sent — reconciled local row, no re-send`);
            return { kind: 'sent', invoiceId: existing.id, amount: existing.total, billingPeriod };
          }
          if (existing) {
            // Found but not yet sent — reuse it (don't double-create) and continue.
            // The issue step tolerates an "already issued" error so it is issued
            // and sent exactly once.
            invoice = existing;
            reusedUnsent = true;
            console.log(`${ctx} snapshot: reusing existing un-sent invoice ${existing.id} (idempotency guard)`);
          } else {
            invoice = await createInvoiceFromOrderSnapshot(accessToken, {
              orderId: order.bexioOrderId,
              isValidFrom: occurrenceDate,
              apiReference: apiRef,
            });
            console.log(`${ctx} snapshot fallback → invoice ${invoice.id}`);
          }
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
          // Was due + claimed, but bexio refused with a permanent 4xx we don't
          // specifically handle → surface it (wasDue) so the reconciliation
          // alerts instead of it passing as a benign not_due. (This is the
          // catch-all that would have caught the "no valid positions" 422.)
          return { kind: 'not_due', reason: err.body.slice(0, 200), wasDue: true };
        }
        console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED status=${err.status} class=${err.errorClass} body=${err.body}`);
      }
    } else {
      console.error(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice FAILED (non-BexioApiError):`, err);
    }
    if (!invoice) {
      await deleteClaim(db, order.bexioOrderId, billingPeriod);
      // B3: a transient error (lost response / 20s timeout) may have arrived AFTER
      // bexio already committed the order-path invoice. That invoice has no
      // api_reference, so the next run's snapshot fallback can't find it — it stays
      // an un-issued/un-sent orphan draft (NOT a double-send: this path never
      // reached issue/send). Flag it as a cleanup hint so the stray draft is
      // actionable rather than mysterious. (We deliberately do NOT auto-adopt it by
      // content search — a contact+date match could grab an unrelated invoice and
      // send the wrong one.)
      const isTransient = err instanceof BexioApiError && err.errorClass === 'transient';
      const orphanHint = isTransient
        ? ' — NOTE: the response was lost mid-flight; bexio may have created an un-sent draft for this order. Check the order in bexio and delete any stray un-sent draft.'
        : '';
      return {
        kind: 'failed',
        reason: (err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err)) + orphanHint,
        bexioStatus: err instanceof BexioApiError ? err.status : undefined,
      };
    }
  }
  if (!invoice) {
    await deleteClaim(db, order.bexioOrderId, billingPeriod);
    return { kind: 'failed', reason: 'invoice creation returned no invoice' };
  }

  // Bexio call succeeded. The invoice_runs (order_id, billing_period) PK is the
  // dedup key and MUST stay anchored to the OCCURRENCE (from isOrderDue), NEVER
  // migrated to bexio's invoice.is_valid_from. The old N-2 migration did exactly
  // that: for a monthly/yearly FIRST invoice (order path) whose is_valid_from
  // bexio set to a later period, it rewrote the key (e.g. 2026-06 → 2026-07),
  // freeing the occurrence key — so a later run inside the catch-up window
  // recomputed 2026-06, found no row, and billed the SAME occurrence again →
  // duplicate invoice + email. is_valid_from is a bexio display detail only; the
  // schedule-anchored key is authoritative for dedup. (Finding 1, 2026-07-02)
  await db
    .update(invoiceRuns)
    .set({ invoiceId: invoice.id, status: 'created', updatedAt: new Date() })
    .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));

  // EDGE-3: refuse a zero/non-positive invoice before any issue/send side effect.
  // bexio already returned the total. Keep the claim row as 'failed' (markFailed,
  // not deleteClaim) so we don't re-create a fresh zero draft every run; Marcus
  // fixes the article price in bexio and can re-trigger. The zero draft stays in
  // bexio un-issued/un-sent for manual cleanup.
  if (shouldRefuseZeroAmountInvoice(invoice.total)) {
    console.error(`${ctx} refusing CHF 0 invoice ${invoice.id} (total=${invoice.total}) — set article prices in bexio`);
    await markFailed(db, order.bexioOrderId, billingPeriod, new Error(`zero-amount invoice (total=${invoice.total}); set article prices in bexio`));
    return {
      kind: 'failed',
      reason: `refusing to issue CHF 0 invoice (total=${invoice.total}) — set the article price in bexio, then re-trigger`,
      invoiceId: invoice.id,
    };
  }

  // Auto-send off: leave the invoice as a created DRAFT (not issued, not sent)
  // for manual handling in bexio. 'created' is a stable resting state — neither
  // retryIssuedRows ('issued') nor reconcileInFlightSends ('sending') touches it,
  // so it is never auto-sent later.
  if (!config.autoSend) {
    console.log(`${ctx} auto-send off — invoice ${invoice.id} left as draft (created, not issued/sent)`);
    return { kind: 'created_unsent', invoiceId: invoice.id, amount: invoice.total, billingPeriod };
  }

  // Step 3: drive through issuing → issued → sending → sent
  // wasIssued tracks whether issueInvoice() succeeded so we can roll back to
  // 'issued' (not 'failed') on send errors — letting retryIssuedRows pick the
  // row up next run instead of marking it terminally failed. (F-2)
  let wasIssued = false;
  try {
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issuing');
    try {
      await issueInvoice(accessToken, invoice.id);
    } catch (issueErr) {
      if (reusedUnsent && issueErr instanceof BexioApiError) {
        // Reused an existing invoice that is likely already festgeschrieben.
        // Treat the issue error as "already issued" and proceed to send once.
        console.warn(`${ctx} issue on reused invoice ${invoice.id} errored (${issueErr.status}) — assuming already issued, proceeding to send`);
      } else {
        throw issueErr;
      }
    }
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
    // BUG-2: mark the send as ATTEMPTED right before the network call. A crash
    // after this point (attempts>0) is reconciled as assumed-sent (N-5); a crash
    // in 'sending' with attempts===0 means we never reached here → safe to retry.
    await db
      .update(invoiceRuns)
      .set({ attempts: sql`${invoiceRuns.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
    await sendInvoice(accessToken, invoice.id, {
      recipientEmail: order.customerEmail,
      subject: renderTemplate(config.mailSubject, { document_nr: docNr }),
      message: renderTemplate(config.mailMessage, { document_nr: docNr }),
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

export type StuckSendingDecision = 'confirmed-sent' | 'assumed-sent' | 'retry';

/**
 * Decide what to do with a stale `status='sending'` row during crash recovery
 * (BUG-2 / BUG-7). Pure so the branch logic is unit-tested in isolation.
 *
 * - confirmed-sent: bexio confirms the mail went out — trust it.
 * - assumed-sent:   bexio doesn't confirm, but `attempts > 0` means the send
 *                   WAS attempted. bexio's is_sent read-back is flaky, so we
 *                   assume it landed rather than re-mail a duplicate (N-5).
 * - retry:          `attempts === 0` means we entered 'sending' but crashed
 *                   BEFORE the send was attempted (attempts is bumped right
 *                   before sendInvoice, not at claim time). No mail went out,
 *                   so retry instead of falsely marking it sent.
 */
export function classifyStuckSendingRow(input: {
  liveIsSent: boolean;
  liveMailSentAt: string | null | undefined;
  attempts: number;
}): StuckSendingDecision {
  if (input.liveIsSent || input.liveMailSentAt) return 'confirmed-sent';
  if (input.attempts > 0) return 'assumed-sent';
  return 'retry';
}

/**
 * Before re-mailing a row parked in 'issued', honor bexio's sent flags (BUG-3).
 * retryIssuedRows re-sends 'issued' rows; a row can land back in 'issued' via
 * the F-2 rollback AFTER sendInvoice already succeeded (the 'sent' DB write
 * failed on a transient blip). Re-sending then double-mails the customer.
 * Returns false when bexio already shows the invoice as sent.
 */
export function shouldResendIssuedRow(live: { is_sent?: boolean; mail_sent_at?: string | null }): boolean {
  return !(live.is_sent || live.mail_sent_at);
}

/**
 * Refuse to issue/send a zero-amount (or non-positive / unparseable) invoice
 * (EDGE-3). The order/snapshot path has no per-position price guard, so a missing
 * article price yields a CHF 0 invoice that bexio accepts and would mail. bexio
 * returns the total after creation — gate on it before any festschreiben/send.
 * Fail-closed: anything not strictly > 0 (incl. null/NaN) is refused.
 */
export function shouldRefuseZeroAmountInvoice(total: unknown): boolean {
  return !(Number(total) > 0);
}

/**
 * During crash recovery, a bexio read-back (getInvoice) may fail. Only a
 * definitive 404 (the invoice is truly gone) is a permanent failure; transient
 * 5xx / rate-limit / auth / network errors must NOT terminally mark a possibly-
 * sent invoice 'failed' — leave it 'sending' for the next run to reconcile. (EDGE-4)
 */
export function shouldFailOnReadbackError(err: unknown): boolean {
  return err instanceof BexioApiError && err.status === 404;
}

/**
 * Crash recovery: find rows in mid-flight whose lock has gone stale.
 * For each, ask bexio if the invoice was actually sent. Resolve accordingly.
 *
 * Run this BEFORE processing new orders in each cron run.
 */
export async function reconcileInFlightSends(db: Db, accessToken: string, dryRun = false): Promise<{
  reconciledSent: number;
  /** N-5 assume-sent fallback (bexio didn't confirm) — surfaced so it is NOT silent (BUG-2). */
  reconciledAssumedSent: number;
  reconciledIssued: number;
  reconciledFailed: number;
}> {
  // Crash recovery resolves stuck rows by issuing/sending real invoices and
  // writing terminal states — pure side-effects. A dry-run must skip it
  // entirely so a "safe preview" can never mail a customer or mutate a row.
  if (dryRun) {
    return { reconciledSent: 0, reconciledAssumedSent: 0, reconciledIssued: 0, reconciledFailed: 0 };
  }

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
  let reconciledAssumedSent = 0;
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
      const decision = classifyStuckSendingRow({
        liveIsSent: Boolean(live.is_sent),
        liveMailSentAt: live.mail_sent_at,
        attempts: row.attempts ?? 0,
      });
      if (decision === 'confirmed-sent') {
        // bexio confirms sent — trust it.
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: live.mail_sent_at ? new Date(live.mail_sent_at) : new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if (decision === 'assumed-sent') {
        // We attempted the send (attempts>0) but bexio's flaky GET /kb_invoice
        // is_sent read-back stays undefined (invoices.ts). Assume it landed to
        // avoid re-mailing a duplicate (N-5) — but count it SEPARATELY so it is
        // surfaced (reconciledAssumedSent) for Marcus to verify delivery (BUG-2).
        console.warn(
          `[reconcile order=${row.orderId} period=${row.billingPeriod}] bexio is_sent unconfirmed after ${row.attempts} send attempt(s) — assuming sent (read-back quirk); VERIFY delivery`,
        );
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: new Date(),
          lockAcquiredAt: null,
        });
        reconciledAssumedSent += 1;
      } else {
        // decision === 'retry': entered 'sending' but crashed BEFORE the send
        // was attempted (attempts===0). No mail went out — roll back to 'issued'
        // so retryIssuedRows re-sends cleanly next run (it owns the attempt count).
        await db
          .update(invoiceRuns)
          .set({ status: 'issued', lockAcquiredAt: null, updatedAt: new Date() })
          .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
        reconciledIssued += 1;
      }
    } catch (err) {
      if (shouldFailOnReadbackError(err)) {
        // Definitive 404 — the invoice is gone in bexio. Terminal.
        await markFailed(db, row.orderId, row.billingPeriod, err);
        reconciledFailed += 1;
      } else {
        // Transient read-back failure (5xx / rate-limit / auth / network). Do
        // NOT terminally fail a possibly-sent invoice — leave it 'sending' with
        // its stale lock so the next run reconciles it again. (EDGE-4)
        console.warn(
          `[reconcile order=${row.orderId} period=${row.billingPeriod}] transient read-back failure — leaving 'sending' for next run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { reconciledSent, reconciledAssumedSent, reconciledIssued, reconciledFailed };
}

export type StuckPreSendDecision = 'reclaim' | 'resume' | 'alert' | 'leave';

/**
 * Decide what to do with a stale pre-send row (status 'creating' / 'issuing')
 * during crash recovery. Pure → unit-tested. These states sit BEFORE
 * 'issued'/'sending' and no other recovery stage touches them, so a crash mid-
 * pipeline wedges them (see reconcileStuckPreSendRows).
 *
 * - reclaim: a 'creating' row with no invoice_id — the claim was won but the
 *            bexio create never recorded an id. interpretClaimResult reads such a
 *            row as concurrent-in-flight forever, so the order silently never
 *            re-bills. Delete the claim so processOrder re-bills.
 * - resume:  an 'issuing' row WITH an invoice_id — the invoice may be
 *            festgeschrieben-but-unsent, so a customer is owed delivery. Route it
 *            back into the 'issued' send lane. 'issuing' is only reached past the
 *            auto_send gate, and a committed invoice must complete regardless of
 *            the CURRENT auto_send (mirrors retryIssuedRows).
 * - alert:   a stale 'created' row WITH auto_send currently ON. 'created' is a
 *            REVERSIBLE draft and recovery must NEVER auto-send it (else an
 *            auto_send OFF→ON flip would festschreiben + mail every parked draft).
 *            But with auto_send on, a stale 'created' row means a crash between the
 *            create and issue writes → the occurrence was never sent and no stage
 *            recovers it (it reads as skipped_duplicate next run). So surface it as
 *            a run error for manual handling — alert only, no side-effect.
 * - leave:   everything else. 'created' with auto_send OFF is an intentional parked
 *            draft (created_unsent) → leave silently. Invariant-violating
 *            combinations (invoice_id is set exactly at the 'created' transition)
 *            are also left — never act on a row we can't reason about.
 */
export function classifyStuckPreSendRow(input: {
  status: string;
  invoiceId: number | null;
  autoSend: boolean;
}): StuckPreSendDecision {
  const { status, invoiceId, autoSend } = input;
  if (status === 'creating') return invoiceId == null ? 'reclaim' : 'leave';
  if (invoiceId == null) return 'leave'; // created/issuing must carry an invoice_id
  if (status === 'issuing') return 'resume';
  if (status === 'created') return autoSend ? 'alert' : 'leave';
  return 'leave';
}

/**
 * Crash recovery for rows wedged in a stale pre-send state ('creating', 'created',
 * 'issuing') — states between the claim and 'issued' that neither
 * reconcileInFlightSends ('sending') nor retryIssuedRows ('issued') covers.
 *
 * Staleness is `updated_at < now()-5min` (these states never set lock_acquired_at,
 * and updated_at is written on the claim insert and every transition). The cutoff
 * guarantees the current run's own in-progress rows are never touched; the
 * advisory-lock + in-flight guard already prevent a concurrent run, so a stale
 * pre-send row is always a crashed prior run.
 *
 * Run this BEFORE retryIssuedRows: 'resume' produces 'issued' rows that
 * retryIssuedRows then sends (inheriting its already-sent guard + attempt limit).
 * 'created' rows are never auto-sent — with auto_send on they are surfaced as
 * `alertedDrafts` (crash between create and issue); with it off they are left as
 * intentional parked drafts.
 */
export async function reconcileStuckPreSendRows(
  db: Db,
  accessToken: string,
  autoSend: boolean,
  dryRun = false,
): Promise<{
  reclaimed: number;
  resumed: number;
  leftDraft: number;
  /** Stale 'created' drafts (auto_send on) never issued/sent — surface for manual handling (B1). */
  alertedDrafts: Array<{ orderId: number; billingPeriod: string; invoiceId: number | null }>;
}> {
  // Reclaim/resume mutate rows and issue real invoices — a dry-run must skip the
  // whole stage before any side-effect (BUG-1 parity).
  if (dryRun) {
    return { reclaimed: 0, resumed: 0, leftDraft: 0, alertedDrafts: [] };
  }

  const cutoff = new Date(Date.now() - LOCK_STALE_MS);

  // 'creating'/'issuing' are the recoverable states (also in the
  // idx_invoice_runs_status_lock partial index); 'created' is scanned only to
  // detect/alert crash-created drafts (never auto-sent).
  const stuck = await db
    .select()
    .from(invoiceRuns)
    .where(
      and(
        inArray(invoiceRuns.status, ['creating', 'created', 'issuing']),
        lt(invoiceRuns.updatedAt, cutoff),
      ),
    );

  let reclaimed = 0;
  let resumed = 0;
  let leftDraft = 0;
  const alertedDrafts: Array<{ orderId: number; billingPeriod: string; invoiceId: number | null }> = [];

  for (const row of stuck) {
    const decision = classifyStuckPreSendRow({
      status: row.status,
      invoiceId: row.invoiceId,
      autoSend,
    });

    if (decision === 'leave') {
      leftDraft += 1;
      continue;
    }

    if (decision === 'alert') {
      // A crash left a bexio draft created but never issued/sent (auto_send on).
      // No stage recovers a 'created' row and the next run reads it as
      // skipped_duplicate — surface it (run.ts pushes a run error) so the missed
      // occurrence is not silent. No side-effect here.
      console.warn(
        `[reconcile-presend order=${row.orderId} period=${row.billingPeriod}] stale 'created' draft (invoice ${row.invoiceId}) — auto-send is on but this occurrence was never issued/sent; verify and send manually in bexio`,
      );
      alertedDrafts.push({ orderId: row.orderId, billingPeriod: row.billingPeriod, invoiceId: row.invoiceId });
      continue;
    }

    if (decision === 'reclaim') {
      // bexio MAY hold an un-issued draft from the order path (no api_reference →
      // not lookupable), but it was never issued/sent, so deleting the claim and
      // letting this run's processOrder re-bill cannot double-send. Log the
      // possible stray draft for manual cleanup.
      console.warn(
        `[reconcile-presend order=${row.orderId} period=${row.billingPeriod}] stale 'creating' claim — deleting so the order re-bills; any bexio draft created pre-crash is un-issued/un-sent and needs manual cleanup`,
      );
      await deleteClaim(db, row.orderId, row.billingPeriod);
      reclaimed += 1;
      continue;
    }

    // decision === 'resume' — invoice_id guaranteed non-null by classify.
    try {
      await issueInvoice(accessToken, row.invoiceId!);
    } catch (err) {
      if (err instanceof BexioApiError) {
        // Likely already festgeschrieben (crash after issue succeeded, before the
        // DB 'issued' write). Mirror processOrder's reusedUnsent tolerance and
        // proceed. If it truly wasn't issued, retryIssuedRows self-corrects to
        // 'failed' at the attempt limit — no wedge, no double-send.
        console.warn(
          `[reconcile-presend order=${row.orderId} period=${row.billingPeriod}] issue on stale '${row.status}' invoice ${row.invoiceId} errored (${err.status}) — assuming already issued, handing to retry`,
        );
      } else {
        // Transient/unexpected — leave the row untouched for the next run's
        // reconciler to retry (EDGE-4 parity).
        console.warn(
          `[reconcile-presend order=${row.orderId} period=${row.billingPeriod}] transient issue failure — leaving '${row.status}' for next run: ${err instanceof Error ? err.message : String(err)}`,
        );
        leftDraft += 1;
        continue;
      }
    }
    await transitionTo(db, row.orderId, row.billingPeriod, 'issued', {
      issuedAt: new Date(),
      lockAcquiredAt: null,
    });
    resumed += 1;
  }

  return { reclaimed, resumed, leftDraft, alertedDrafts };
}

/**
 * Retry rows in 'issued' state that didn't reach 'sent' (e.g. recovered from crash).
 *
 * Atomically claims ALL eligible rows in one UPDATE-RETURNING transition to
 * 'sending' + attempts++; concurrent workers won't see the same rows. (N-4)
 */
export async function retryIssuedRows(db: Db, accessToken: string, config: MailConfig, dryRun = false): Promise<number> {
  // Re-sends real invoice mails for rows parked in 'issued'. A dry-run must
  // never reach sendInvoice — skip the whole stage before any DB claim.
  if (dryRun) {
    return 0;
  }

  // Claim atomically (status='sending' + lock) so concurrent workers can't grab
  // the same rows (N-4). Do NOT bump attempts here: attempts must equal REAL send
  // attempts, so a crash mid-loop (before a given row's send) leaves it at its
  // pre-claim attempts and is reconciled as 'retry', not falsely 'assumed-sent'
  // (BUG-2 parity — attempts is bumped per-row right before sendInvoice below).
  const claimed = await db
    .update(invoiceRuns)
    .set({
      status: 'sending',
      lockAcquiredAt: new Date(),
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
      // BUG-3: a row can land back in 'issued' via the F-2 rollback AFTER
      // sendInvoice already succeeded (the 'sent' DB write failed on a transient
      // blip). Re-sending would double-mail the customer. Honor bexio's sent
      // flags — if already sent, resolve to 'sent' without re-mailing.
      if (!shouldResendIssuedRow(live)) {
        console.warn(
          `[retry order=${row.orderId} period=${row.billingPeriod}] invoice ${row.invoiceId} already sent in bexio — resolving to 'sent' without re-mailing (BUG-3)`,
        );
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: live.mail_sent_at ? new Date(live.mail_sent_at) : new Date(),
          lockAcquiredAt: null,
        });
        recovered += 1;
        continue;
      }
      const docNr = live.document_nr;
      // BUG-2 parity: bump attempts IMMEDIATELY before the send network call, not
      // at claim. A crash after this point (attempts>0) is reconciled as
      // assumed-sent; a crash before it (attempts unchanged) is reconciled as retry.
      await db
        .update(invoiceRuns)
        .set({ attempts: sql`${invoiceRuns.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
      await sendInvoice(accessToken, row.invoiceId, {
        recipientEmail: order.customerEmail,
        subject: renderTemplate(config.mailSubject, { document_nr: docNr }),
        message: renderTemplate(config.mailMessage, { document_nr: docNr }),
        attachPdf: true,
      });
      await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
        sentAt: new Date(),
        lockAcquiredAt: null,
      });
      recovered += 1;
    } catch (err) {
      // Roll back to 'issued' so future runs can retry, unless the attempt just
      // made (row.attempts from the claim is the PRE-bump value) was the last one.
      if (row.attempts != null && row.attempts + 1 >= MAX_ATTEMPTS) {
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
