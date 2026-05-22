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

describe('formatBillingPeriod — weekly (ISO week)', () => {
  test('first Monday of 2026 → 2026-W01', () => {
    // 2026-01-05 is Monday of ISO week 2 actually — let me anchor on a Thursday
    // 2026-01-01 is a Thursday → ISO week 1 of 2026
    expect(formatBillingPeriod('2026-01-01', 'weekly')).toBe('2026-W01');
  });

  test('year-end where week belongs to next year: 2025-12-29 (Mon) is W01 of 2026', () => {
    // ISO rule: week 1 contains year's first Thursday. 2026-01-01 is Thu,
    // so the week starting Mon 2025-12-29 IS ISO week 1 of 2026.
    expect(formatBillingPeriod('2025-12-29', 'weekly')).toBe('2026-W01');
  });

  test('year-end where week belongs to prior year: 2027-01-03 (Sun) is W53 of 2026', () => {
    // 2026 starts on Thursday → year has 53 ISO weeks. 2027-01-01 is Friday,
    // so Sun 2027-01-03 still belongs to W53 of 2026.
    expect(formatBillingPeriod('2027-01-03', 'weekly')).toBe('2026-W53');
  });

  test('mid-year week is zero-padded', () => {
    // 2026-05-22 is Friday of ISO week 21
    expect(formatBillingPeriod('2026-05-22', 'weekly')).toBe('2026-W21');
  });
});

describe('formatBillingPeriod — invalid input', () => {
  test('throws on unparseable date', () => {
    expect(() => formatBillingPeriod('not-a-date', 'daily')).toThrow();
  });
});
