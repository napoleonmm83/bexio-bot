// OAuth token lifecycle: refresh + DB-backed cache.
// Worker calls getValidAccessToken() on every call; refresh happens transparently.

import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { secrets } from '@bexio-bot/db';
import { BexioApiError, type TokenResponse } from './types.ts';
import { callTokenEndpoint } from './http.ts';

// Refresh proactively when access token expires within this window.
const REFRESH_BUFFER_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

async function readSecret(db: Db, key: string): Promise<{ value: string; expiresAt: Date | null } | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.key, key));
  const row = rows[0];
  if (!row) return null;
  return { value: row.value, expiresAt: row.expiresAt };
}

async function writeSecret(db: Db, key: string, value: string, expiresAt: Date | null): Promise<void> {
  await db
    .insert(secrets)
    .values({ key, value, expiresAt })
    .onConflictDoUpdate({
      target: secrets.key,
      set: { value, expiresAt, updatedAt: new Date() },
    });
}

/**
 * Returns a non-expired access token. Refreshes via refresh_token if needed.
 * Throws if the refresh token is missing or refresh fails — worker stops, user re-auths.
 */
export async function getValidAccessToken(db: Db): Promise<string> {
  const access = await readSecret(db, 'bexio_access_token');
  if (access && access.expiresAt && access.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return access.value;
  }

  // Need to refresh
  const refresh = await readSecret(db, 'bexio_refresh_token');
  if (!refresh) {
    throw new BexioApiError(
      401,
      'auth',
      'No refresh token in DB. Run `bun run oauth-setup` and grant access in browser.',
    );
  }

  const clientId = process.env.BEXIO_CLIENT_ID;
  const clientSecret = process.env.BEXIO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new BexioApiError(401, 'auth', 'BEXIO_CLIENT_ID / BEXIO_CLIENT_SECRET not in env.');
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refresh.value);
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);

  const res = await callTokenEndpoint(params);
  if (!res.ok) {
    const body = await res.text();
    throw new BexioApiError(res.status, 'auth', `Token refresh failed: ${body}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // bexio rotates the refresh token on every refresh — must persist BOTH
  await writeSecret(db, 'bexio_access_token', tokens.access_token, newExpiresAt);
  await writeSecret(db, 'bexio_refresh_token', tokens.refresh_token, null);

  return tokens.access_token;
}
