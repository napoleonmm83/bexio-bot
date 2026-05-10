// Worker entry point. Three modes:
//   bun run worker              — full daily run (default; honors WORKER_DRY_RUN)
//   bun run worker:dry          — same as above but WORKER_DRY_RUN=true forced
//   bun run worker --check      — connectivity check (Postgres + bexio-API), no mutations

import { closeDb, getDb } from '@bexio-bot/db';
import { sql } from 'drizzle-orm';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { runDaily } from './lib/run.ts';

const args = process.argv.slice(2);
const mode = args.includes('--check') ? 'check' : 'run';
const dryRun = process.env.WORKER_DRY_RUN === 'true';

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
  } else {
    console.log('');
    console.log('bexio-bot worker run');
    console.log('═══════════════════');
    console.log('  dry-run:   ', dryRun);
    console.log('  timezone:  ', process.env.WORKER_TZ ?? 'Europe/Zurich');
    console.log('');

    const summary = await runDaily(db, { dryRun });

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
    console.log('');
    console.log('Crash recovery:');
    console.log('  reconciled to sent:  ', summary.reconciledSent);
    console.log('  reconciled to issued:', summary.reconciledIssued);
    console.log('  marked failed:       ', summary.reconciledFailed);
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
      } else if (r.result.kind === 'not_due') {
        console.log(`    ${r.result.reason}`);
      } else if (r.result.kind === 'skipped_duplicate') {
        console.log(`    existing invoice ${r.result.existingInvoiceId} period ${r.result.billingPeriod}`);
      } else if (r.result.kind === 'failed') {
        console.log(`    reason: ${r.result.reason}`);
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
    case 'not_due': return '·';
    case 'skipped_duplicate': return '↺';
    case 'failed': return '✗';
    default: return '?';
  }
}
