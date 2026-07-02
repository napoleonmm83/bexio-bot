import { expect, test, describe } from 'bun:test';
import { formatBillingPeriod } from './billing-period.ts';

describe('formatBillingPeriod — monthly (default)', () => {
  test('mid-May 2026 → 2026-05', () => {
    expect(formatBillingPeriod('2026-05-22', 'monthly')).toBe('2026-05');
  });

  test('undefined type defaults to monthly', () => {
    expect(formatBillingPeriod('2026-05-22')).toBe('2026-05');
  });

  test('yearly still uses monthly granularity (≤1 invoice per month)', () => {
    expect(formatBillingPeriod('2026-12-01', 'yearly')).toBe('2026-12');
  });

  test('UTC date at midnight is still May in Zurich (UTC+2 summer)', () => {
    // 2026-05-22T00:00:00Z = 2026-05-22T02:00 in Zurich → still May
    expect(formatBillingPeriod('2026-05-22T00:00:00Z', 'monthly')).toBe('2026-05');
  });
});

describe('formatBillingPeriod — daily', () => {
  test('regression for AU-00013 incident: 2026-05-22 → 2026-05-22', () => {
    expect(formatBillingPeriod('2026-05-22', 'daily')).toBe('2026-05-22');
  });

  test('different day same month yields different period (the actual fix)', () => {
    expect(formatBillingPeriod('2026-05-21', 'daily')).toBe('2026-05-21');
    expect(formatBillingPeriod('2026-05-22', 'daily')).toBe('2026-05-22');
  });

  test('zero-pads single-digit month and day', () => {
    expect(formatBillingPeriod('2026-01-05', 'daily')).toBe('2026-01-05');
  });

  test('DST spring-forward day (2026-03-29) still formats correctly', () => {
    expect(formatBillingPeriod('2026-03-29', 'daily')).toBe('2026-03-29');
  });

  test('DST fall-back day (2026-10-25) still formats correctly', () => {
    expect(formatBillingPeriod('2026-10-25', 'daily')).toBe('2026-10-25');
  });
});

describe('formatBillingPeriod — weekly (occurrence-anchored DAY, not ISO week) [C1]', () => {
  // ISO-week granularity collided for weekly orders configured with 2+ weekdays:
  // Monday and Thursday of the same ISO week mapped to one 'YYYY-Www' key, so the
  // (order_id, billing_period) guard deduped the second occurrence away → the order
  // billed once/week instead of per configured weekday. Day granularity (same as
  // daily) gives each configured weekday its own slot; a single-weekday weekly
  // order still yields exactly one key per occurrence (the key is occurrence-anchored).
  test('two weekdays in the SAME ISO week now get DIFFERENT keys (the fix)', () => {
    expect(formatBillingPeriod('2026-06-29', 'weekly')).toBe('2026-06-29'); // Monday
    expect(formatBillingPeriod('2026-07-02', 'weekly')).toBe('2026-07-02'); // Thursday, same week
    expect(formatBillingPeriod('2026-06-29', 'weekly')).not.toBe(formatBillingPeriod('2026-07-02', 'weekly'));
  });

  test('single weekday → one key per occurrence', () => {
    expect(formatBillingPeriod('2026-05-22', 'weekly')).toBe('2026-05-22');
  });

  test('zero-pads single-digit month/day', () => {
    expect(formatBillingPeriod('2026-01-05', 'weekly')).toBe('2026-01-05');
  });
});

describe('formatBillingPeriod — invalid input', () => {
  test('throws on unparseable date', () => {
    expect(() => formatBillingPeriod('not-a-date', 'daily')).toThrow();
  });
});
