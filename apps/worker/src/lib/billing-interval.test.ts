import { expect, test, describe } from 'bun:test';
import { addBillingInterval } from './billing-interval.ts';

describe('addBillingInterval — monthly', () => {
  test('mid-month: 2026-05-15 + monthly = 2026-06-15', () => {
    const result = addBillingInterval(new Date('2026-05-15T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  test('Jan 31 + monthly = Feb 28 (non-leap)', () => {
    const result = addBillingInterval(new Date('2027-01-31T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-02-28');
  });

  test('Jan 31 + monthly in leap year = Feb 29', () => {
    const result = addBillingInterval(new Date('2028-01-31T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  test('December rolls year: 2026-12-15 + monthly = 2027-01-15', () => {
    const result = addBillingInterval(new Date('2026-12-15T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

describe('addBillingInterval — yearly', () => {
  test('mid-year: 2026-05-15 + yearly = 2027-05-15', () => {
    const result = addBillingInterval(new Date('2026-05-15T00:00:00Z'), 'yearly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-05-15');
  });

  test('Feb 29 leap → Feb 28 non-leap', () => {
    const result = addBillingInterval(new Date('2028-02-29T00:00:00Z'), 'yearly');
    expect(result.toISOString().slice(0, 10)).toBe('2029-02-28');
  });
});
