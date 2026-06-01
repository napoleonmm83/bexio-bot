// App settings store (key/value). Web (/settings) writes; worker reads with an
// env fallback during the migration off process.env. Mirrors the proven `secrets`
// upsert pattern in bexio-client/auth.ts. NO secrets here — see schema.ts comment.

import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { appSettings } from './schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

/**
 * Read a setting by key. Returns the stored string, or `fallback` (default
 * undefined) when the key is absent. Callers parse/validate as needed.
 */
export async function getSetting(
  db: Db,
  key: string,
  fallback?: string,
): Promise<string | undefined> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return rows[0]?.value ?? fallback;
}

/**
 * Read several settings at once into a plain object (missing keys omitted).
 * Convenience for the worker, which needs a handful of values per run.
 */
export async function getSettings(db: Db, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const rows = await db.select().from(appSettings);
  const wanted = new Set(keys);
  const out: Record<string, string> = {};
  for (const r of rows) if (wanted.has(r.key)) out[r.key] = r.value;
  return out;
}

/** Upsert a setting. Updates `updated_at` on conflict. */
export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
