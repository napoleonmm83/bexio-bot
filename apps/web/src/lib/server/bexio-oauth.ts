// Server-only bexio OAuth helpers used by /auth/bexio and /callback.
// Mirror of the logic in apps/worker/src/oauth-setup.ts; consolidate into
// packages/bexio-client when the duplication starts to bite.

import { createHash, randomBytes } from 'node:crypto';

export const AUTH_URL = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth';
export const TOKEN_URL = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token';

// Required scopes per endpoint, verified live against bexio (2026-05).
export const SCOPES = [
  'openid',
  'offline_access',
  'kb_order_show',
  'kb_order_edit',
  'kb_invoice_show',
  'kb_invoice_edit',
  'contact_show',
].join(' ');

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  return { verifier, challenge, state };
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', opts.code);
  params.set('redirect_uri', opts.redirectUri);
  params.set('client_id', opts.clientId);
  params.set('client_secret', opts.clientSecret);
  params.set('code_verifier', opts.verifier);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<TokenResponse>;
}
