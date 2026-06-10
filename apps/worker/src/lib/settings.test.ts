import { expect, test, describe } from 'bun:test';
import { clampDueWindowDays } from './settings.ts';

describe('clampDueWindowDays — bounded, integer due-window (EDGE-10)', () => {
  test('valid in-range values preserved (as integer)', () => {
    expect(clampDueWindowDays('3')).toBe(3);
    expect(clampDueWindowDays('31')).toBe(31);
    expect(clampDueWindowDays(7)).toBe(7);
  });

  test('fractional values are floored', () => {
    expect(clampDueWindowDays('2.5')).toBe(2);
  });

  test('values over the max are clamped to 31', () => {
    expect(clampDueWindowDays('100000')).toBe(31);
    expect(clampDueWindowDays('32')).toBe(31);
  });

  test('negative / non-numeric / undefined → default 3', () => {
    expect(clampDueWindowDays('-1')).toBe(3);
    expect(clampDueWindowDays('abc')).toBe(3);
    expect(clampDueWindowDays(undefined)).toBe(3);
  });
});
