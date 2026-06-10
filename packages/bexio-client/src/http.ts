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

// Hard ceiling on every bexio request. Without it, an auth/API host that accepts
// the TCP connection but never responds hangs the fetch forever — and during a
// token refresh that pins the pg advisory lock + a pooled DB connection
// indefinitely, silently freezing all billing (BUG-4). 20s is far above any
// legitimate bexio response yet bounds the worst case.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Turn a fetch rejection (timeout or network failure) into a classified,
 * transient BexioApiError so the state machine retries instead of crashing — and
 * so a hung token-refresh cannot outlive the bounded call. Pure, so the mapping
 * is unit-tested without a network. (BUG-4)
 */
export function classifyFetchError(err: unknown): BexioApiError {
  if (err instanceof BexioApiError) return err;
  const name = err instanceof Error ? err.name : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  return new BexioApiError(
    isTimeout ? 408 : 503,
    'transient',
    isTimeout
      ? `bexio request timed out after ${FETCH_TIMEOUT_MS}ms`
      : `network error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw classifyFetchError(err);
  }
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
  const res = await fetchWithTimeout(url, init);

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
  // fetchWithTimeout: a hung auth host must NOT pin the token-refresh advisory
  // lock indefinitely (BUG-4). On timeout/network-failure this throws a transient
  // BexioApiError, which rolls back the refresh transaction and releases the lock.
  return fetchWithTimeout(`${BEXIO_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
}
