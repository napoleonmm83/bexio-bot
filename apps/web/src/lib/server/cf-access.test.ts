import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyCfAccess } from './cf-access.ts';

// Real crypto end-to-end: sign with a generated RS256 key, serve its JWKS via a
// mocked fetch. Guards against a jose upgrade that silently rejects EVERY token
// (which a live "401 without token" probe cannot tell apart from a healthy gate).

const TEAM = 'cfaccess-test';
const AUD = 'test-aud';
const ISS = `https://${TEAM}.cloudflareaccess.com`;

let privateKey: CryptoKey;
const realFetch = globalThis.fetch;
const env = { team: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISS}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('unexpected fetch', { status: 500 });
  }) as typeof fetch;
  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.CF_ACCESS_AUD = AUD;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env.CF_ACCESS_TEAM_DOMAIN = env.team;
  process.env.CF_ACCESS_AUD = env.aud;
});

async function token(claims: { aud?: string; iss?: string; email?: string } = {}) {
  return new SignJWT({ email: claims.email ?? 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(claims.iss ?? ISS)
    .setAudience(claims.aud ?? AUD)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const req = (jwt?: string) =>
  new Request('https://bexio-bot.test/', jwt ? { headers: { 'cf-access-jwt-assertion': jwt } } : {});

async function errCode(p: Promise<unknown>) {
  try {
    await p;
    return 'no-error';
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe('verifyCfAccess — real RS256 verification', () => {
  test('valid token → identity', async () => {
    const id = await verifyCfAccess(req(await token()));
    expect(id.email).toBe('owner@example.com');
    expect(id.subject).toBe('owner@example.com');
    expect(id.aud).toBe(AUD);
  });

  test('wrong audience → verify-failed', async () => {
    expect(await errCode(verifyCfAccess(req(await token({ aud: 'other-app' }))))).toBe('verify-failed');
  });

  test('wrong issuer → verify-failed', async () => {
    expect(await errCode(verifyCfAccess(req(await token({ iss: 'https://evil.cloudflareaccess.com' }))))).toBe('verify-failed');
  });

  test('missing header → missing-header', async () => {
    expect(await errCode(verifyCfAccess(req()))).toBe('missing-header');
  });

  test('missing env → server-misconfigured (fail-closed)', async () => {
    delete process.env.CF_ACCESS_AUD;
    try {
      expect(await errCode(verifyCfAccess(req(await token())))).toBe('server-misconfigured');
    } finally {
      process.env.CF_ACCESS_AUD = AUD;
    }
  });
});
