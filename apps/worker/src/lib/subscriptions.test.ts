import { expect, test, describe } from 'bun:test';
import { BexioApiError } from '@bexio-bot/bexio-client';
import { validateSubscriptionInputs, classifyForRetry } from './subscriptions.ts';

describe('validateSubscriptionInputs — fail-closed on missing email + zero price', () => {
  test('auto-send subscription with missing contact email → throws (N-7)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: true,
        contactMail: null,
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/contact.*email/i);
  });

  test('auto-send false with missing email → ok (issue but don\'t send)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: null,
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).not.toThrow();
  });

  test('article with missing sale_price → throws (N-8)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: 'a@b.ch',
        articles: [{ id: 1, sale_price: null }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/sale_price/i);
  });

  test('article with zero sale_price → throws (N-8)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: 'a@b.ch',
        articles: [{ id: 1, sale_price: '0' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/sale_price/i);
  });

  test('happy path — all inputs valid', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: true,
        contactMail: 'kunde@example.ch',
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).not.toThrow();
  });
});

describe('classifyForRetry — distinguish retryable vs permanent', () => {
  test('transient bexio error → delete-and-retry', () => {
    const err = new BexioApiError(500, 'transient', 'gateway timeout');
    expect(classifyForRetry(err)).toBe('delete-and-retry');
  });

  test('rate_limit → delete-and-retry', () => {
    const err = new BexioApiError(429, 'rate_limit', 'too many');
    expect(classifyForRetry(err)).toBe('delete-and-retry');
  });

  test('permanent 4xx → keep-failed', () => {
    const err = new BexioApiError(422, 'permanent', 'validation');
    expect(classifyForRetry(err)).toBe('keep-failed');
  });

  test('auth error (401) → keep-failed', () => {
    const err = new BexioApiError(401, 'auth', 'token expired');
    expect(classifyForRetry(err)).toBe('keep-failed');
  });

  test('non-BexioApiError (local validation) → keep-failed', () => {
    expect(classifyForRetry(new Error('subscription validation: foo'))).toBe('keep-failed');
  });
});
