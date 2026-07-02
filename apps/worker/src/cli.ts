// Worker entry point. Three modes:
//   bun run worker              — full daily run (default; honors WORKER_DRY_RUN)
//   bun run worker:dry          — same as above but WORKER_DRY_RUN=true forced
//   bun run worker --check      — connectivity check (Postgres + bexio-API), no mutations

import { closeDb, getDb, getSetting } from '@bexio-bot/db';
import { sql } from 'drizzle-orm';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { runDaily } from './lib/run.ts';
import { syncRecurringOrders } from './lib/sync.ts';

const args = process.argv.slice(2);
const mode = args.includes('--check')
  ? 'check'
  : args.includes('--sync')
    ? 'sync'
    : 'run';
const dryRun = process.env.WORKER_DRY_RUN === 'true';
const onlyOrderId = parseOnlyOrderId(args, process.env.WORKER_ONLY_ORDER_ID);

const db = getDb();

try {
  if (mode === 'check') {
    console.log('bexio-bot worker — connectivity check');

    const result = await db.execute(sql`SELECT version() as version, now() as now`);
    const row = result[0] as { version: string; now: string | Date };
    console.log('  postgres:       ', row.version.split(',')[0]);
    console.log('  postgres now:   ', new Date(row.now).toISOString());

    const token = await getValidAccessToken(db);
    console.log('  bexio token:    ', `${token.length} chars (refresh-aware)`);

    console.log('OK — connectivity verified.');
  } else if (mode === 'sync') {
    // Incremental order sync only — NO billing. Hit by the every-2h Coolify
    // scheduled task so new/changed bexio orders surface within hours.
    console.log('bexio-bot worker — incremental sync (no billing)');
    const enabled = (await getSetting(db, 'incremental_sync_enabled', 'true')) !== 'false';
    if (!enabled) {
      console.log('  incremental_sync_enabled=false — skipping');
    } else {
      const token = await getValidAccessToken(db);
      const result = await syncRecurringOrders(db, token, { mode: 'incremental' });
      console.log(`  checked: ${result.total}  new: ${result.newlyAdded}  updated: ${result.alreadyTracked}`);
      for (const n of result.newOrders) console.log(`    + #${n.bexioOrderId} ${n.customerName} (${n.interval})`);
      for (const d of result.driftWarnings) console.log(`    ⚠ drift #${d.bexioOrderId} ${d.customerName}: ${d.detail}`);
    }
    console.log('SYNC DONE');
  } else {
    console.log('');
    console.log('bexio-bot worker run');
    console.log('═══════════════════');
    console.log('  dry-run:   ', dryRun);
    console.log('  timezone:  ', process.env.WORKER_TZ ?? 'Europe/Zurich');
    console.log('');

    if (onlyOrderId != null) {
      console.log('  only order:', onlyOrderId);
    }

    const summary = await runDaily(db, { dryRun, onlyOrderId });

    console.log('Run #', summary.runId, '  duration:', `${summary.finishedAt.getTime() - summary.startedAt.getTime()}ms`);
    console.log('');
    console.log('Sync:');
    console.log('  bexio recurring orders found:', summary.syncTotal);
    console.log('  newly added (enabled=false): ', summary.syncNewlyAdded);
    if (summary.newOrders.length) {
      for (const n of summary.newOrders) {
        console.log(`    + #${n.bexioOrderId} ${n.customerName} (${n.interval})`);
      }
    }
    if (summary.removedOrders > 0) {
      console.log('  removed (no longer in bexio):', summary.removedOrders);
    }
    console.log('');
    console.log('Crash recovery:');
    console.log('  reconciled to sent:  ', summary.reconciledSent);
    if (summary.reconciledAssumedSent > 0) {
      console.log('  ⚠ assumed sent (VERIFY delivery):', summary.reconciledAssumedSent);
    }
    console.log('  reconciled to issued:', summary.reconciledIssued);
    console.log('  marked failed:       ', summary.reconciledFailed);
    if (summary.reconciledReclaimed > 0) {
      console.log('  ⚠ reclaimed stale claim (check bexio for orphan draft):', summary.reconciledReclaimed);
    }
    if (summary.reconciledResumed > 0) {
      console.log('  resumed stuck pre-send:', summary.reconciledResumed);
    }
    console.log('  retried from issued: ', summary.retriedFromIssued);
    console.log('');
    console.log('Enabled orders:', summary.enabledOrders);
    if (summary.enabledOrders === 0) {
      console.log('  (no orders are enabled. Activate them in the dashboard /orders page once Phase 1 web ships.)');
    }
    for (const r of summary.results) {
      const symbol = symbolFor(r.result.kind);
      console.log(`  ${symbol} #${r.orderId} ${r.customerName.slice(0, 40)} — ${r.result.kind}`);
      if (r.result.kind === 'sent') {
        console.log(`    invoice ${r.result.invoiceId} CHF ${r.result.amount} period ${r.result.billingPeriod}`);
      } else if (r.result.kind === 'created_unsent') {
        console.log(`    draft invoice ${r.result.invoiceId} CHF ${r.result.amount} period ${r.result.billingPeriod} (auto-send off)`);
      } else if (r.result.kind === 'not_due') {
        console.log(`    ${r.result.reason}`);
      } else if (r.result.kind === 'skipped_duplicate') {
        console.log(`    existing invoice ${r.result.existingInvoiceId} period ${r.result.billingPeriod}`);
      } else if (r.result.kind === 'failed') {
        console.log(`    reason: ${r.result.reason}`);
      } else if (r.result.kind === 'skipped_unsupported') {
        console.log(`    bexio type "${r.result.bexioType}" wird vom Bot nicht unterstützt — bitte manuell in bexio bearbeiten`);
      }
    }
    console.log('');
    console.log('Totals:');
    console.log('  created:', summary.createdInvoicesCount);
    console.log('  sent:   ', summary.sentInvoicesCount);
    if (summary.errors.length) {
      console.log('  errors:');
      for (const e of summary.errors) console.log(`    ${e.stage} — ${e.message}`);
    }
    console.log('');
    console.log('Notifications:');
    if (summary.notifyResults.length === 0) {
      console.log('  (no channels configured — set DISCORD_WEBHOOK_URL to enable)');
    }
    for (const n of summary.notifyResults) {
      if (n.ok) {
        console.log(`  ✓ ${n.channel}: delivered`);
      } else {
        console.log(`  ✗ ${n.channel}: ${'status' in n && n.status ? `${n.status} — ` : ''}${n.error}`);
      }
    }
    console.log('');
    console.log(summary.errors.length ? 'DONE_WITH_ERRORS' : 'DONE');
  }
} catch (err) {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}

function symbolFor(kind: string): string {
  switch (kind) {
    case 'sent': return '✓';
    case 'created_unsent': return '📝';
    case 'not_due': return '·';
    case 'skipped_duplicate': return '↺';
    case 'skipped_unsupported': return '⚠';
    case 'failed': return '✗';
    default: return '?';
  }
}

function parseOnlyOrderId(args: string[], envValue: string | undefined): number | undefined {
  const argValue = args.find((a) => a.startsWith('--order-id='));
  const splitValue = argValue?.slice('--order-id='.length)
    ?? (args.includes('--order-id') ? args[args.indexOf('--order-id') + 1] : undefined)
    ?? envValue;

  if (!splitValue) return undefined;
  const parsed = Number(splitValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --order-id value: ${splitValue}`);
  }
  return parsed;
}
