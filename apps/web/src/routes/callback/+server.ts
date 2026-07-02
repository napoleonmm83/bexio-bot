import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exchangeCode } from '$lib/server/bexio-oauth.ts';
import { getCompanyProfile, isAllowedBexioCompany } from '@bexio-bot/bexio-client';
import { getDb, secrets } from '@bexio-bot/db';
import type { RequestHandler } from './$types.ts';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const { BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET, BEXIO_REDIRECT_URI } = env;
  if (!BEXIO_CLIENT_ID || !BEXIO_CLIENT_SECRET || !BEXIO_REDIRECT_URI) {
    error(500, 'bexio OAuth env vars not configured');
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    error(400, `bexio: ${oauthError} ${url.searchParams.get('error_description') ?? ''}`);
  }
  if (!code) error(400, 'Missing authorization code in callback');

  const expectedState = cookies.get('bexio_oauth_state');
  const verifier = cookies.get('bexio_pkce_verifier');
  if (!expectedState || !verifier) {
    error(400, 'OAuth session expired or missing — restart at /auth/bexio');
  }
  if (returnedState !== expectedState) {
    error(400, 'State mismatch — possible CSRF, aborting');
  }

  // Single-use cookies; clear before exchange so a partial failure can't replay.
  cookies.delete('bexio_oauth_state', { path: '/' });
  cookies.delete('bexio_pkce_verifier', { path: '/' });

  const tokens = await exchangeCode({
    code,
    verifier,
    redirectUri: BEXIO_REDIRECT_URI,
    clientId: BEXIO_CLIENT_ID,
    clientSecret: BEXIO_CLIENT_SECRET,
  });

  // OAuth rebind guard (SEC): state+PKCE only stop CSRF, not an attacker running
  // their OWN bexio OAuth end-to-end against this public callback and clobbering
  // the shared token rows. When BEXIO_ALLOWED_COMPANY is configured, verify the
  // connecting org matches before storing tokens. Fail-open (no check) when unset
  // so re-auth is never locked out before the allowlist is configured.
  const allowed = env.BEXIO_ALLOWED_COMPANY;
  if (allowed) {
    let profile = null;
    try {
      profile = await getCompanyProfile(tokens.access_token);
    } catch (e) {
      console.error('[callback] could not fetch company_profile to verify the connecting org:', e);
      error(502, 'Could not verify the bexio organization — try again.');
    }
    if (!isAllowedBexioCompany(profile, allowed)) {
      console.error(
        `[callback] REJECTED OAuth bind: connecting org ${profile ? `"${profile.name}" (id=${profile.id}, mwst=${profile.mwst_nr ?? '-'})` : 'unknown'} is not on the allowlist — tokens NOT stored`,
      );
      error(403, 'This bexio organization is not authorized to connect this bot.');
    }
    console.log(`[callback] bexio org authorized: "${profile?.name}" (id=${profile?.id})`);
  }

  const db = getDb();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .insert(secrets)
    .values({ key: 'bexio_refresh_token', value: tokens.refresh_token })
    .onConflictDoUpdate({
      target: secrets.key,
      set: { value: tokens.refresh_token, updatedAt: new Date() },
    });

  await db
    .insert(secrets)
    .values({ key: 'bexio_access_token', value: tokens.access_token, expiresAt })
    .onConflictDoUpdate({
      target: secrets.key,
      set: { value: tokens.access_token, expiresAt, updatedAt: new Date() },
    });

  redirect(302, '/?auth=ok');
};
