// Daily worker run orchestration. Called from cli.ts with --run.
//
// Order of operations:
//   1. Refresh bexio access token (auto via getValidAccessToken)
//   2. Sync recurring orders into local cache (writes recurring_orders rows)
//   3. Reconcile any in-flight 'sending' rows that crashed last run
//   4. Retry any 'issued' rows whose send didn't complete
//   5. For each enabled order: process through state machine
//   6. Write bot_runs row with summary

import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { botRuns } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { notifyAll, type ChannelResult } from '@bexio-bot/notify';
import { syncRecurringOrders, getEnabledOrders, getProcessableOrderById } from './sync.ts';
import { loadWorkerSettings } from './settings.ts';
import {
  processOrder,
  reconcileInFlightSends,
  reconcileStuckPreSendRows,
  retryIssuedRows,
  type ProcessOrderResult,
} from './state-machine.ts';
// Subscription pipeline retired 2026-06-01 (see step 5b). Type kept for the
// (now always empty) RunSummary field so downstream consumers are unchanged.
import { type ProcessSubscriptionResult } from './subscriptions.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

export type RunSummary = {
  runId: number;
  startedAt: Date;
  finishedAt: Date;
  syncTotal: number;
  syncNewlyAdded: number;
  removedOrders: number;
  newOrders: Array<{ bexioOrderId: number; customerName: string; interval: string }>;
  reconciledSent: number;
  /** N-5 assume-sent fallback (bexio didn't confirm delivery) — verify manually (BUG-2). */
  reconciledAssumedSent: number;
  reconciledIssued: number;
  reconciledFailed: number;
  /** Stale 'creating' claims deleted so the order re-bills (possible orphan draft in bexio). */
  reconciledReclaimed: number;
  /** Stale 'created'/'issuing' rows re-issued and handed to the send lane. */
  reconciledResumed: number;
  retriedFromIssued: number;
  enabledOrders: number;
  results: Array<{ orderId: number; customerName: string; result: ProcessOrderResult }>;
  subscriptionResults: ProcessSubscriptionResult[];
  createdInvoicesCount: number;
  sentInvoicesCount: number;
  errors: Array<{ stage: string; message: string }>;
  notifyResults: ChannelResult[];
};

export type TriggerSource = 'cron' | 'cowork' | 'manual';

export type RunDailyOptions = {
  dryRun: boolean;
  /** Optional live-test guard: process only this bexio order id. */
  onlyOrderId?: number;
  /** Distinguishes how this run was kicked off. Defaults to 'cron'. */
  triggerSource?: TriggerSource;
  /**
   * Reuse an existing bot_runs row instead of inserting a new one.
   * The HTTP trigger endpoint inserts the row up-front (so the caller
   * gets the runId synchronously) and passes it here.
   */
  existingRunId?: number;
};

// pg advisory-lock key that serializes the cron/CLI in-flight check-and-insert.
// Distinct from the token-refresh lock (4242001). (EDGE-5)
const RUN_LOCK_KEY = 4242002;
// A run older than this with no finished_at is treated as dead (matches the HTTP
// trigger endpoint's default). (EDGE-5)
const RUN_STALE_MS = Number(process.env.WORKER_RUN_STALE_MS ?? 2 * 60 * 60 * 1000);

/**
 * True if a previous run is still in flight (unfinished and younger than the
 * stale cutoff). Pure → unit-tested. (EDGE-5)
 */
export function isAnotherRunInFlight(inFlightStartedAt: Date | null, now: number, staleMs: number): boolean {
  if (inFlightStartedAt == null) return false;
  return now - inFlightStartedAt.getTime() < staleMs;
}

export type BillingAnomaly = { orderId: number; customerName: string; reason: string };

/**
 * Post-run reconciliation: find enabled orders that were DUE this run but did NOT
 * end in a successful billing outcome — so a due-but-unbilled order can never pass
 * as a silent success ("Lauf erfolgreich, 0 Fehler"). An anomaly is either a
 * `failed` result or a `not_due` that carries `wasDue` (a bexio error swallowed
 * after the due-gate already passed). sent / created_unsent / skipped_duplicate
 * are billed-or-already-billed; genuine not_due (not scheduled) and
 * skipped_unsupported (surfaced separately) are not anomalies. Pure → unit-tested.
 */
export function collectBillingAnomalies(
  results: Array<{ orderId: number; customerName: string; result: ProcessOrderResult }>,
): BillingAnomaly[] {
  const anomalies: BillingAnomaly[] = [];
  for (const r of results) {
    if (r.result.kind === 'failed') {
      anomalies.push({ orderId: r.orderId, customerName: r.customerName, reason: `Rechnung fehlgeschlagen: ${r.result.reason}` });
    } else if (r.result.kind === 'not_due' && r.result.wasDue === true) {
      anomalies.push({ orderId: r.orderId, customerName: r.customerName, reason: `fällig, aber nicht fakturiert: ${r.result.reason}` });
    }
  }
  return anomalies;
}

function buildSkippedSummary(runId: number, startedAt: Date, finishedAt: Date): RunSummary {
  return {
    runId,
    startedAt,
    finishedAt,
    syncTotal: 0,
    syncNewlyAdded: 0,
    removedOrders: 0,
    newOrders: [],
    reconciledSent: 0,
    reconciledAssumedSent: 0,
    reconciledIssued: 0,
    reconciledFailed: 0,
    reconciledReclaimed: 0,
    reconciledResumed: 0,
    retriedFromIssued: 0,
    enabledOrders: 0,
    results: [],
    subscriptionResults: [],
    createdInvoicesCount: 0,
    sentInvoicesCount: 0,
    errors: [{ stage: 'runDaily', message: 'skipped — another run already in progress (EDGE-5)' }],
    notifyResults: [],
  };
}

export async function runDaily(db: Db, options: RunDailyOptions): Promise<RunSummary> {
  const startedAt = new Date();
  const errors: RunSummary['errors'] = [];
  const triggerSource: TriggerSource = options.triggerSource ?? 'cron';

  // ── 1. Open bot_runs row (or reuse) ────────────────────────────────
  let runId: number;
  if (options.existingRunId != null) {
    // HTTP trigger path already did its own in-flight check and inserted the row.
    runId = options.existingRunId;
  } else {
    // Cron/CLI path: serialize the in-flight check + insert under a pg advisory
    // lock so two runs (the daily cron racing a Cowork trigger, or two crons)
    // can't both proceed. The lock is held only for this short transaction; the
    // inserted bot_runs row (finished_at IS NULL) is the in-flight marker
    // thereafter. Per-order claim rows already prevent double-billing; this
    // prevents wasted parallel API load + interleaving. (EDGE-5)
    const claim = await db.transaction(async (tx) => {
      const lockRes = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${RUN_LOCK_KEY}) AS locked`);
      const locked = (lockRes[0] as { locked?: boolean } | undefined)?.locked === true;
      const inFlight = await tx
        .select({ startedAt: botRuns.startedAt })
        .from(botRuns)
        .where(sql`${botRuns.finishedAt} IS NULL`)
        .orderBy(sql`${botRuns.startedAt} DESC`)
        .limit(1);
      const blocked = !locked || isAnotherRunInFlight(inFlight[0]?.startedAt ?? null, Date.now(), RUN_STALE_MS);
      if (blocked) {
        // Record a finished 'skipped' row for the audit trail (does not affect
        // in-flight detection — it has finished_at set).
        const [row] = await tx
          .insert(botRuns)
          .values({
            startedAt,
            finishedAt: new Date(),
            triggerSource,
            notes: 'skipped — another run already in progress (EDGE-5)',
          })
          .returning({ id: botRuns.id });
        return { skipped: true as const, runId: row!.id };
      }
      const [row] = await tx
        .insert(botRuns)
        .values({ startedAt, triggerSource, notes: options.dryRun ? 'dry-run' : null })
        .returning({ id: botRuns.id });
      return { skipped: false as const, runId: row!.id };
    });

    if (claim.skipped) {
      console.warn('runDaily: another run already in progress — skipping this trigger (EDGE-5)');
      return buildSkippedSummary(claim.runId, startedAt, new Date());
    }
    runId = claim.runId;
  }

  // ── 2. Token + runtime settings + Sync ──────────────────────
  // Settings resolve DB (app_settings) → env → default. Loaded once and
  // threaded into the pipeline so a /settings change applies next run.
  const accessToken = await getValidAccessToken(db);
  const settings = await loadWorkerSettings(db);
  const sync = await syncRecurringOrders(db, accessToken, { dryRun: options.dryRun });
  // EDGE-2: orders skipped mid-sync surface as run errors (→ bot_runs + Discord)
  // instead of silently vanishing.
  for (const f of sync.failedOrders) {
    errors.push({ stage: `sync(order ${f.bexioOrderId})`, message: f.message });
  }

  // ── 3 + 4. Crash recovery ───────────────────────────────────
  // Both stages issue/send real invoices and write terminal states. They MUST
  // honor dryRun (BUG-1): previously they ran unconditionally before the
  // dry-run gate below, so a "dry" run silently re-mailed any parked 'issued'
  // invoice. The dryRun flag short-circuits both before any side-effect.
  const reconcile = await reconcileInFlightSends(db, accessToken, options.dryRun);
  // Pre-send recovery MUST run before retryIssuedRows: a 'resume' produces an
  // 'issued' row that retryIssuedRows then sends (inheriting its send-once guard).
  const preSend = await reconcileStuckPreSendRows(db, accessToken, options.dryRun);
  // A reclaimed 'creating' claim means an occurrence was mid-billing at crash. The
  // due-gate never back-bills, so if the occurrence has since advanced (any daily
  // order, or a monthly past its catch-up window) that period is dropped with no
  // new invoice — it must NOT pass as a silent success. Surface it → bot_runs
  // errors_jsonb + Discord (per-order detail is in the container logs via warn).
  // reclaimed is always 0 in dry-run, so this is inherently dry-run-safe.
  if (preSend.reclaimed > 0) {
    errors.push({
      stage: 'crash-recovery',
      message: `${preSend.reclaimed} stale 'creating' claim(s) reclaimed — a billing period may have been dropped without back-billing; check the worker logs and verify the affected order(s) in bexio`,
    });
  }
  const retriedFromIssued = await retryIssuedRows(db, accessToken, settings, options.dryRun);

  // ── 5. Process enabled orders ───────────────────────────────
  const enabled = options.onlyOrderId == null
    ? await getEnabledOrders(db)
    : await getProcessableOrderById(db, options.onlyOrderId);
  const results: RunSummary['results'] = [];

  for (const o of enabled) {
    if (options.dryRun) {
      results.push({
        orderId: o.bexioOrderId,
        customerName: o.customerName,
        result: { kind: 'not_due', reason: '(dry-run: did not create or send an invoice)' },
      });
      continue;
    }

    try {
      const result = await processOrder(db, accessToken, {
        bexioOrderId: o.bexioOrderId,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
      }, settings);
      results.push({ orderId: o.bexioOrderId, customerName: o.customerName, result });
    } catch (err) {
      errors.push({
        stage: `processOrder(${o.bexioOrderId})`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5a. Billing reconciliation ──────────────────────────────
  // A due order that failed or was silently swallowed as not_due must NOT let the
  // run read "erfolgreich, 0 Fehler". Surface each as a run error → bot_runs
  // errors_jsonb + Discord. (Skipped in dry-run: results are all synthetic not_due.)
  if (!options.dryRun) {
    for (const a of collectBillingAnomalies(results)) {
      errors.push({ stage: `billing-anomaly(order ${a.orderId})`, message: `${a.customerName}: ${a.reason}` });
    }
  }

  // ── 5b. Subscription-layer pipeline — DEPRECATED (2026-06-01) ─────────
  // The bot-native subscription pipeline is retired: it was never used in
  // production (0 rows, confirmed by live probe) and the order pipeline already
  // covers every billing cycle correctly. New recurring billing goes through
  // bexio orders (see /orders/import). The subscriptions/billing_runs tables
  // remain (empty) for history, and no new subscriptions can be created — the
  // worker no longer bills or reconciles them.
  const subscriptionResults: ProcessSubscriptionResult[] = [];

  // ── 6. Close bot_runs row ───────────────────────────────────
  const finishedAt = new Date();
  // F-8: separate counters — `created` now means truly NEW invoices this run.
  // skipped_duplicate is a no-op (a row already existed for the period) and
  // should not be conflated with creation.
  // `created` = truly new invoices this run (sent OR created-as-draft when
  // auto-send is off). `sent` = only those actually mailed. skipped_duplicate is
  // a no-op and counts as neither.
  const created = results.filter(
    (r) => r.result.kind === 'sent' || r.result.kind === 'created_unsent',
  ).length;
  const sent = results.filter((r) => r.result.kind === 'sent').length;

  await db
    .update(botRuns)
    .set({
      finishedAt,
      createdInvoicesCount: created,
      sentInvoicesCount: sent,
      errorsJsonb: errors.length ? sql`${JSON.stringify(errors)}::jsonb` : null,
    })
    .where(eq(botRuns.id, runId));

  // ── 7. Fire-and-forget notifications ────────────────────────
  // Promise.allSettled in notifyAll() ensures a failing channel never blocks the run.
  const notifyResults = await notifyAll({
    runId,
    startedAt,
    finishedAt,
    enabledOrders: enabled.length,
    newOrders: sync.newOrders,
    driftWarnings: sync.driftWarnings,
    unsupportedOrders: sync.unsupportedOrders,
    errors,
    results: results.map((r) => ({
      customerName: r.customerName,
      kind: r.result.kind,
      ...(r.result.kind === 'sent'
        ? { invoiceId: r.result.invoiceId, amount: r.result.amount, billingPeriod: r.result.billingPeriod }
        : {}),
      ...(r.result.kind === 'created_unsent'
        ? { invoiceId: r.result.invoiceId, amount: r.result.amount, billingPeriod: r.result.billingPeriod }
        : {}),
      ...(r.result.kind === 'skipped_duplicate'
        ? { invoiceId: r.result.existingInvoiceId, billingPeriod: r.result.billingPeriod }
        : {}),
      ...(r.result.kind === 'failed' ? { reason: r.result.reason } : {}),
      ...(r.result.kind === 'not_due' ? { reason: r.result.reason } : {}),
      ...(r.result.kind === 'skipped_unsupported' ? { reason: `bexio type "${r.result.bexioType}" nicht unterstützt` } : {}),
    })),
    subscriptionResults: subscriptionResults.map((r) => ({
      kind: r.kind,
      subscriptionId: r.subscriptionId,
      ...(r.kind === 'sent' ? { invoiceId: r.invoiceId, amount: r.amount, scheduledFor: r.scheduledFor } : {}),
      ...(r.kind === 'failed' ? { reason: r.reason, scheduledFor: r.scheduledFor } : {}),
      ...(r.kind === 'skipped_duplicate' ? { scheduledFor: r.scheduledFor } : {}),
    })),
  }, {
    enabled: settings.notificationsEnabled,
    discordWebhookUrl: settings.discordWebhookUrl,
    dashboardUrl: settings.dashboardUrl,
  });

  return {
    runId,
    startedAt,
    finishedAt,
    syncTotal: sync.total,
    syncNewlyAdded: sync.newlyAdded,
    removedOrders: sync.removedOrders,
    newOrders: sync.newOrders,
    reconciledSent: reconcile.reconciledSent,
    reconciledAssumedSent: reconcile.reconciledAssumedSent,
    reconciledIssued: reconcile.reconciledIssued,
    reconciledFailed: reconcile.reconciledFailed,
    reconciledReclaimed: preSend.reclaimed,
    reconciledResumed: preSend.resumed,
    retriedFromIssued,
    enabledOrders: enabled.length,
    results,
    subscriptionResults,
    createdInvoicesCount: created,
    sentInvoicesCount: sent,
    errors,
    notifyResults,
  };
}
