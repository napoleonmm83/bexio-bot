import { expect, test, describe } from 'bun:test';
import { isPublicRoute, makeAuthHandle } from './route-auth.ts';

describe('isPublicRoute — only health + OAuth routes bypass CF Access (SEC-1)', () => {
  test('public: health canary + bexio OAuth flow', () => {
    for (const p of ['/health', '/callback', '/auth/bexio', '/auth/bexio/reauth']) {
      expect(isPublicRoute(p)).toBe(true);
    }
  });

  test('protected: every dashboard route, form action, and API endpoint', () => {
    for (const p of [
      '/', '/settings', '/subscriptions', '/subscriptions/123', '/billing-runs',
      '/orders/import', '/runs', '/api/trigger-run', '/api/sync', '/api/runs/5',
    ]) {
      expect(isPublicRoute(p)).toBe(false);
    }
  });

  test('prefix-confusion paths must NOT be treated as public', () => {
    for (const p of ['/healthz', '/health-x', '/callbackx', '/callback-evil', '/auth/bexiox', '/authx']) {
      expect(isPublicRoute(p)).toBe(false);
    }
  });
});

describe('makeAuthHandle — origin-side CF Access gate (SEC-1)', () => {
  const okResolve = async () => new Response('ok', { status: 200 });

  function cfErr(code: string) {
    const e = new Error(`cf: ${code}`) as Error & { code: string };
    e.name = 'CfAccessError';
    e.code = code;
    return e;
  }

  test('public route skips verification and resolves', async () => {
    let verifyCalled = false;
    const handle = makeAuthHandle(async () => { verifyCalled = true; return {}; });
    const res = await handle({
      event: { url: new URL('https://x/health'), request: new Request('https://x/health'), locals: {} },
      resolve: okResolve,
    } as never);
    expect(verifyCalled).toBe(false);
    expect(res.status).toBe(200);
  });

  test('protected route with failing verify returns 401 and does NOT resolve', async () => {
    let resolved = false;
    const handle = makeAuthHandle(async () => { throw cfErr('missing-header'); });
    const res = await handle({
      event: { url: new URL('https://x/settings'), request: new Request('https://x/settings'), locals: {} },
      resolve: async () => { resolved = true; return new Response('LEAK', { status: 200 }); },
    } as never);
    expect(res.status).toBe(401);
    expect(resolved).toBe(false);
  });

  test('protected route with valid verify sets locals.cfAccess and resolves', async () => {
    const identity = { subject: 'a@b.ch' };
    const event = {
      url: new URL('https://x/settings'),
      request: new Request('https://x/settings'),
      locals: {} as Record<string, unknown>,
    };
    const handle = makeAuthHandle(async () => identity);
    const res = await handle({ event, resolve: okResolve } as never);
    expect(res.status).toBe(200);
    expect(event.locals.cfAccess).toBe(identity);
  });

  test('server-misconfigured maps to 500, not 401', async () => {
    const handle = makeAuthHandle(async () => { throw cfErr('server-misconfigured'); });
    const res = await handle({
      event: { url: new URL('https://x/'), request: new Request('https://x/'), locals: {} },
      resolve: okResolve,
    } as never);
    expect(res.status).toBe(500);
  });

  test('a non-CfAccess error propagates (not swallowed as 401)', async () => {
    const handle = makeAuthHandle(async () => { throw new Error('db down'); });
    await expect(
      handle({
        event: { url: new URL('https://x/'), request: new Request('https://x/'), locals: {} },
        resolve: okResolve,
      } as never),
    ).rejects.toThrow('db down');
  });
});
