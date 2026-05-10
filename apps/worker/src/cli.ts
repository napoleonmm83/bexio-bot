// Pre-Phase 0a stack-check: verify Bun + Postgres + Drizzle wire up correctly.
// Real worker logic lands in Phase 1.

import { getDb, closeDb } from '@bexio-bot/db';
import { sql } from 'drizzle-orm';

const dryRun = process.env.WORKER_DRY_RUN === 'true';

console.log('bexio-bot worker — stack check');
console.log('  bun version:    ', Bun.version);
console.log('  WORKER_DRY_RUN: ', dryRun);
console.log('  WORKER_TZ:      ', process.env.WORKER_TZ ?? '(not set, defaulting to Europe/Zurich)');

try {
  const db = getDb();
  const result = await db.execute(sql`SELECT version() as version, now() as now`);
  const row = result[0] as { version: string; now: Date };
  console.log('  postgres:       ', row.version.split(',')[0]);
  console.log('  postgres now:   ', row.now.toISOString());
  console.log('OK — stack works.');
} catch (err) {
  console.error('FAIL — stack check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await closeDb();
}
