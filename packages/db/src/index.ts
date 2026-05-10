import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.ts';

export * from './schema.ts';

let _client: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb(databaseUrl?: string) {
  if (_db) return _db;

  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL not set. Copy .env.example to .env.local or set the env var.');
  }

  _client = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  _db = drizzle(_client, { schema });
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = undefined;
    _db = undefined;
  }
}
