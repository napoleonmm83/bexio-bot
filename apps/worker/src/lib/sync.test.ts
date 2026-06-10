import { expect, test, describe } from 'bun:test';
import { shouldRunOrphanCleanup, coerceExpectedAmount } from './sync.ts';

describe('shouldRunOrphanCleanup — protect cache from partial/empty lists (F-7, EDGE-1)', () => {
  test('non-empty, complete list → run cleanup', () => {
    expect(shouldRunOrphanCleanup({ seenCount: 5, truncated: false })).toBe(true);
  });

  test('empty list → skip (F-7: transient API blip, not "deleted everything")', () => {
    expect(shouldRunOrphanCleanup({ seenCount: 0, truncated: false })).toBe(false);
  });

  test('list truncated at the pagination cap → skip (EDGE-1: would delete every past-cap order)', () => {
    expect(shouldRunOrphanCleanup({ seenCount: 5200, truncated: true })).toBe(false);
  });
});

describe('coerceExpectedAmount — malformed bexio total never reaches the NOT NULL column (EDGE-2)', () => {
  test('valid decimal string preserved verbatim', () => {
    expect(coerceExpectedAmount('12.50')).toBe('12.50');
  });

  test('null / undefined → "0"', () => {
    expect(coerceExpectedAmount(null)).toBe('0');
    expect(coerceExpectedAmount(undefined)).toBe('0');
  });

  test('empty / whitespace / non-numeric → "0"', () => {
    expect(coerceExpectedAmount('')).toBe('0');
    expect(coerceExpectedAmount('   ')).toBe('0');
    expect(coerceExpectedAmount('abc')).toBe('0');
  });

  test('numeric input coerced to string', () => {
    expect(coerceExpectedAmount(42)).toBe('42');
  });
});
