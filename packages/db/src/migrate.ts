// Migration runner. Called from Dockerfile entrypoint in prod, runnable locally.
// Usage: bun run packages/db/src/migrate.ts

import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Resolve migrations folder relative to this script, not CWD — works whether
// invoked from repo root (`bun run db:migrate`) or from inside packages/db.
const migrationsFolder = resolve(import.meta.dir, '..', 'migrations');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

console.log('Running migrations against', url.replace(/:[^:@/]+@/, ':***@'));
console.log('Migrations folder:        ', migrationsFolder);
await migrate(db, { migrationsFolder });
console.log('Migrations complete');

await client.end();
