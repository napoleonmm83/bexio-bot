import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { buildAuthUrl, generatePkce } from '$lib/server/bexio-oauth.ts';
import type { RequestHandler } from './$types.ts';

const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  maxAge: 300,
} as const;

export const GET: RequestHandler = ({ cookies }) => {
  const { BEXIO_CLIENT_ID, BEXIO_REDIRECT_URI } = env;
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

  redirect(302, authUrl);
};
