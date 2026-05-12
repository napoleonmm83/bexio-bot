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
import { syncRecurringOrders, getEnabledOrders } from './sync.ts';
import {
  processOrder,
  reconcileInFlightSends,
  retryIssuedRows,
  type ProcessOrderResult,
} from './state-machine.ts';
import { processSubscriptions, type ProcessSubscriptionResult } from './subscriptions.ts';

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
  reconciledIssued: number;
  reconciledFailed: number;
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
  /** Distinguishes how this run was kicked off. Defaults to 'cron'. */
  triggerSource?: TriggerSource;
  /**
   * Reuse an existing bot_runs row instead of inserting a new one.
   * The HTTP trigger endpoint inserts the row up-front (so the caller
   * gets the runId synchronously) and passes it here.
   */
  existingRunId?: number;
};

export async function runDaily(db: Db, options: RunDailyOptions): Promise<RunSummary> {
  const startedAt = new Date();
  const errors: RunSummary['errors'] = [];
  const triggerSource: TriggerSource = options.triggerSource ?? 'cron';

  // ── 1. Open bot_runs row (or reuse) ────────────────────────────────
  let runId: number;
  if (options.existingRunId != null) {
    runId = options.existingRunId;
  } else {
    const [runRow] = await db
      .insert(botRuns)
      .values({
        startedAt,
        triggerSource,
        notes: options.dryRun ? 'dry-run' : null,
      })
      .returning({ id: botRuns.id });
    runId = runRow!.id;
  }

  // ── 2. Token + Sync ─────────────────────────────────────────
  const accessToken = await getValidAccessToken(db);
  const sync = await syncRecurringOrders(db, accessToken);

  // ── 3 + 4. Crash recovery ───────────────────────────────────
  const reconcile = await reconcileInFlightSends(db, accessToken);
  const retriedFromIssued = await retryIssuedRows(db, accessToken);

  // ── 5. Process enabled orders ───────────────────────────────
  const enabled = await getEnabledOrders(db);
  const results: RunSummary['results'] = [];

  for (const o of enabled) {
    if (options.dryRun) {
      results.push({
        orderId: o.bexioOrderId,
        customerName: o.customerName,
        result: { kind: 'not_due', reason: '(dry-run: did not call POST /repetition)' },
      });
      continue;
    }

    try {
      const result = await processOrder(db, accessToken, {
        bexioOrderId: o.bexioOrderId,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
      });
      results.push({ orderId: o.bexioOrderId, customerName: o.customerName, result });
    } catch (err) {
      errors.push({
        stage: `processOrder(${o.bexioOrderId})`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5b. Subscription-layer pipeline ──────────────────────────────────
  let subscriptionResults: ProcessSubscriptionResult[] = [];
  if (!options.dryRun) {
    try {
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      subscriptionResults = await processSubscriptions(db, accessToken, today);
    } catch (err) {
      errors.push({
        stage: 'processSubscriptions',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 6. Close bot_runs row ───────────────────────────────────
  const finishedAt = new Date();
  const created =
    results.filter((r) => r.result.kind === 'sent' || r.result.kind === 'skipped_duplicate').length +
    subscriptionResults.filter((r) => r.kind === 'sent' || r.kind === 'skipped_duplicate').length;
  const sent =
    results.filter((r) => r.result.kind === 'sent').length +
    subscriptionResults.filter((r) => r.kind === 'sent').length;

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
    errors,
    results: results.map((r) => ({
      customerName: r.customerName,
      kind: r.result.kind,
      ...(r.result.kind === 'sent'
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
    reconciledIssued: reconcile.reconciledIssued,
    reconciledFailed: reconcile.reconciledFailed,
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
