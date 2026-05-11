import type { HandleServerError } from '@sveltejs/kit';

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
