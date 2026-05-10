// Migration runner. Called from Dockerfile entrypoint in prod, runnable locally.
// Usage: bun run packages/db/src/migrate.ts

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

console.log('Running migrations against', url.replace(/:[^:@/]+@/, ':***@'));
await migrate(db, { migrationsFolder: './migrations' });
console.log('Migrations complete');

await client.end();
