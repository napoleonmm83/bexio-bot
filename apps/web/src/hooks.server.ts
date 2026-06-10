import type { HandleServerError } from '@sveltejs/kit';
import { verifyCfAccess } from '$lib/server/cf-access.ts';
import { makeAuthHandle } from '$lib/server/route-auth.ts';

// SEC-1: origin-side Cloudflare Access gate for ALL non-public routes — page
// loads, form actions, AND /api/*. Previously only the three /api/* endpoints
// verified the CF-Access JWT in code; dashboard pages and money-moving form
// actions (runNow / retry / toggle / settings) relied solely on the CF edge,
// which a direct-to-origin request bypasses until the firewall lock lands.
// Public exemptions (/health, /callback, /auth/bexio) live in route-auth.ts.
export const handle = makeAuthHandle(verifyCfAccess);

export const handleError: HandleServerError = ({ error, event, status, message }) => {
  // SvelteKit's default error logger prints `undefined` for non-Error throws
  // and hides the stack; this hook surfaces enough detail to debug 500s
  // (especially during the Coolify bootstrap where /health is the canary).
  const path = event.url.pathname;
  const err = error as { message?: string; stack?: string; cause?: unknown } | null;
  // eslint-disable-next-line no-console
  console.error(`[handleError] ${status} ${event.request.method} ${path}: ${message}`);
  // eslint-disable-next-line no-console
  console.error('error:', err?.message ?? err);
  if (err?.stack) {
    // eslint-disable-next-line no-console
    console.error('stack:', err.stack);
  }
  if (err?.cause) {
    // eslint-disable-next-line no-console
    console.error('cause:', err.cause);
  }
};
