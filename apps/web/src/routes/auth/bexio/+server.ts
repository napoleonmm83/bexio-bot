import { redirect, error } from '@sveltejs/kit';
import { BEXIO_CLIENT_ID, BEXIO_REDIRECT_URI, NODE_ENV } from '$app/env/private';
import { AUTH_URL, buildAuthUrl, generatePkce } from '#lib/server/bexio-oauth.ts';
import type { RequestHandler } from './$types.ts';

const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: NODE_ENV === 'production',
  maxAge: 300
} as const;

export const GET: RequestHandler = ({ cookies }) => {
  if (!BEXIO_CLIENT_ID || !BEXIO_REDIRECT_URI) {
    error(500, 'BEXIO_CLIENT_ID or BEXIO_REDIRECT_URI not configured');
  }

  const { verifier, challenge, state } = generatePkce();

  cookies.set('bexio_pkce_verifier', verifier, COOKIE_OPTS);
  cookies.set('bexio_oauth_state', state, COOKIE_OPTS);

  const authUrl = buildAuthUrl({
    clientId: BEXIO_CLIENT_ID,
    redirectUri: BEXIO_REDIRECT_URI,
    state,
    challenge,
  });

  // Kit 3 rejects external redirects unless the origin is allowlisted.
  redirect(302, authUrl, { external: [new URL(AUTH_URL).origin] });
};
