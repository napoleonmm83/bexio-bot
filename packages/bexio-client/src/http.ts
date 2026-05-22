// HTTP layer with retry classification + simple rate-limit pacing.
// Token-bucket + Header-Aware-Backoff is Phase 2 polish; for now: 1.1s between calls
// (Marcus picked Token-Bucket in D10 — TODO: upgrade to bottleneck-style bucket).

import { BexioApiError, type BexioErrorClass } from './types.ts';

export const BEXIO_API_BASE = 'https://api.bexio.com/2.0' as const;
export const BEXIO_AUTH_BASE = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect' as const;

const MIN_GAP_MS = 1100; // ~54 req/min, comfortably below bexio's typical 60/min limit
let lastCallAt = 0;
let paceChain: Promise<void> = Promise.resolve();

/**
 * Serialize pace() across concurrent callers. The previous implementation
 * shared a mutable lastCallAt without any queue, so two callers calling
 * pace() within MIN_GAP_MS would both sleep until the same instant and
 * then burst. With Promise.all in subscriptions.ts (multiple getArticle
 * calls) this caused 429 rate-limit errors. (N-9)
 */
async function pace(): Promise<void> {
  const myTurn = paceChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }
    lastCallAt = Date.now();
  });
  // Don't let one failure poison the chain for future callers.
  paceChain = myTurn.catch(() => undefined);
  await myTurn;
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

  // Build init conditionally — bexio's POST /kb_order/{id}/invoice returns 415
  // if the request has ANY body (even an empty string or undefined that Bun
  // might serialize as Content-Length: 0). Omit the key entirely instead.
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);

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
