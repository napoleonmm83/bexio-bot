// HTTP layer with retry classification + simple rate-limit pacing.
// Token-bucket + Header-Aware-Backoff is Phase 2 polish; for now: 1.1s between calls
// (Marcus picked Token-Bucket in D10 — TODO: upgrade to bottleneck-style bucket).

import { BexioApiError, type BexioErrorClass } from './types.ts';

export const BEXIO_API_BASE = 'https://api.bexio.com/2.0' as const;
export const BEXIO_AUTH_BASE = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect' as const;

const MIN_GAP_MS = 1100; // ~54 req/min, comfortably below bexio's typical 60/min limit
let lastCallAt = 0;

async function pace(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  lastCallAt = Date.now();
}

function classifyStatus(status: number): BexioErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export type ApiCallOptions = {
  accessToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean>;
};

/**
 * Single API call with paced execution + error classification.
 * Caller is responsible for retry policy (state machine in worker handles attempts).
 */
export async function callBexio<T>(path: string, opts: ApiCallOptions): Promise<T> {
  await pace();

  const url = new URL(`${BEXIO_API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const bodyText = await res.text();
    const errorClass = classifyStatus(res.status);
    let retryAfter: number | undefined;
    if (errorClass === 'rate_limit') {
      const headerValue = res.headers.get('retry-after');
      if (headerValue) {
        const parsed = parseInt(headerValue, 10);
        if (!Number.isNaN(parsed)) retryAfter = parsed;
      }
    }
    throw new BexioApiError(res.status, errorClass, bodyText, retryAfter);
  }

  // 204 No Content (e.g. /issue, /send may return empty)
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

// Token endpoint uses different base URL + different content type
export async function callTokenEndpoint(formBody: URLSearchParams): Promise<Response> {
  await pace();
  return fetch(`${BEXIO_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
}
