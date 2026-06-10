// Origin-side Cloudflare Access gate (SEC-1).
//
// hooks.server.ts wires `makeAuthHandle(verifyCfAccess)` as the global `handle`
// hook so EVERY non-public route — dashboard loads, form actions, and /api/*
// alike — is verified at the origin, not just the three /api/* endpoints that
// previously called verifyCfAccess themselves. Until the Hetzner origin-lock
// firewall lands, this is the only thing stopping a direct-to-origin request
// (bypassing the CF edge) from reading data or firing a money-moving action.
//
// PUBLIC routes must work WITHOUT a CF-signed JWT:
//   /health      — Coolify deploy canary, polled before any CF cookie exists
//   /callback    — bexio OAuth redirect target (guarded by the OAuth flow)
//   /auth/bexio  — initiates / re-initiates the bexio OAuth flow (only redirects to bexio)
// Everything else is protected.

import type { Handle } from '@sveltejs/kit';

const PUBLIC_PREFIXES = ['/health', '/callback', '/auth/bexio'] as const;

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export type CfVerify = (request: Request) => Promise<unknown>;

// Duck-typed so this module stays free of the cf-access.ts (jose) import: the
// real CfAccessError sets `this.name = 'CfAccessError'` and a string `code`.
type CfAccessLike = { name?: string; code?: string; message?: string };
function asCfAccessError(err: unknown): CfAccessLike | null {
  if (err && typeof err === 'object' && (err as CfAccessLike).name === 'CfAccessError') {
    return err as CfAccessLike;
  }
  return null;
}

/**
 * Build the global SvelteKit `handle` hook. `verify` throws CfAccessError on a
 * missing/invalid CF-Access JWT (or server-misconfigured). On a protected
 * route, a verification failure short-circuits with a 401 (or 500 for
 * misconfiguration) and `resolve` is never called. On success the identity is
 * stashed on `event.locals.cfAccess`. Non-CfAccess errors propagate.
 */
export function makeAuthHandle(verify: CfVerify): Handle {
  return async ({ event, resolve }) => {
    if (isPublicRoute(event.url.pathname)) {
      return resolve(event);
    }
    try {
      (event.locals as Record<string, unknown>).cfAccess = await verify(event.request);
    } catch (err) {
      const cf = asCfAccessError(err);
      if (!cf) throw err;
      const status = cf.code === 'server-misconfigured' ? 500 : 401;
      return new Response(
        JSON.stringify({ error: cf.code, message: cf.message }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return resolve(event);
  };
}
