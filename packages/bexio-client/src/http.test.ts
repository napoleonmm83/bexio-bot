import { expect, test, describe } from 'bun:test';
import { classifyFetchError } from './http.ts';
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
