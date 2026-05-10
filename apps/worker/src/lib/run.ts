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
  createdInvoicesCount: number;
  sentInvoicesCount: number;
  errors: Array<{ stage: string; message: string }>;
  notifyResults: ChannelResult[];
};

export async function runDaily(db: Db, options: { dryRun: boolean }): Promise<RunSummary> {
  const startedAt = new Date();
  const errors: RunSummary['errors'] = [];

  // ── 1. Open bot_runs row ────────────────────────────────────
  const [runRow] = await db
    .insert(botRuns)
    .values({ startedAt, notes: options.dryRun ? 'dry-run' : null })
    .returning({ id: botRuns.id });
  const runId = runRow!.id;

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
      });
      results.push({ orderId: o.bexioOrderId, customerName: o.customerName, result });
    } catch (err) {
      errors.push({
        stage: `processOrder(${o.bexioOrderId})`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 6. Close bot_runs row ───────────────────────────────────
  const finishedAt = new Date();
  const created = results.filter((r) => r.result.kind === 'sent' || r.result.kind === 'skipped_duplicate').length;
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
    createdInvoicesCount: created,
    sentInvoicesCount: sent,
    errors,
    notifyResults,
  };
}
