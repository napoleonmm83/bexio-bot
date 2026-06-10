import { expect, test, describe } from 'bun:test';
import { classifyFetchError, retryAfterDelayMs, classifyTokenError } from './http.ts';
import { BexioApiError } from './types.ts';

describe('classifyFetchError — network/timeout failures become transient BexioApiError (BUG-4)', () => {
  test('AbortSignal.timeout (TimeoutError) → 408 transient', () => {
    const e = new Error('The operation timed out.');
    e.name = 'TimeoutError';
    const out = classifyFetchError(e);
    expect(out).toBeInstanceOf(BexioApiError);
    expect(out.errorClass).toBe('transient');
    expect(out.status).toBe(408);
  });

  test('AbortError → 408 transient', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    const out = classifyFetchError(e);
    expect(out.errorClass).toBe('transient');
    expect(out.status).toBe(408);
  });

  test('network TypeError (fetch failed / DNS / reset) → 503 transient', () => {
    const out = classifyFetchError(new TypeError('fetch failed'));
    expect(out.errorClass).toBe('transient');
    expect(out.status).toBe(503);
  });

  test('an existing BexioApiError passes through unchanged', () => {
    const orig = new BexioApiError(422, 'permanent', 'bad');
    expect(classifyFetchError(orig)).toBe(orig);
  });
});

describe('retryAfterDelayMs — honor bexio Retry-After, capped (BUG-6)', () => {
  test('undefined → null (no info to act on)', () => {
    expect(retryAfterDelayMs(undefined)).toBe(null);
  });
  test('positive seconds → milliseconds', () => {
    expect(retryAfterDelayMs(5)).toBe(5000);
  });
  test('capped at 30s', () => {
    expect(retryAfterDelayMs(100)).toBe(30000);
  });
  test('zero → 0 (retry immediately)', () => {
    expect(retryAfterDelayMs(0)).toBe(0);
  });
  test('negative → null (invalid)', () => {
    expect(retryAfterDelayMs(-5)).toBe(null);
  });
});

describe('classifyTokenError — classify + redact OAuth token-endpoint errors (BUG-8, SEC-2)', () => {
  test('invalid_grant → auth; message carries the code, NOT the raw body/token', () => {
    const r = classifyTokenError(400, '{"error":"invalid_grant","error_description":"expired","refresh_token":"SECRETTOKEN"}');
    expect(r.errorClass).toBe('auth');
    expect(r.message).toContain('invalid_grant');
    expect(r.message).not.toContain('SECRETTOKEN');
  });
  test('invalid_client → auth', () => {
    expect(classifyTokenError(401, '{"error":"invalid_client"}').errorClass).toBe('auth');
  });
  test('429 → rate_limit (not auth)', () => {
    expect(classifyTokenError(429, 'too many requests').errorClass).toBe('rate_limit');
  });
  test('5xx → transient (not auth)', () => {
    expect(classifyTokenError(503, 'gateway down').errorClass).toBe('transient');
    expect(classifyTokenError(500, '{"error":"server_error"}').errorClass).toBe('transient');
  });
  test('url-encoded body: token never leaks into the message', () => {
    const r = classifyTokenError(400, 'refresh_token=LEAKEDTOKEN&error=invalid_grant');
    expect(r.message).not.toContain('LEAKEDTOKEN');
    expect(r.message).toContain('invalid_grant');
  });
});
