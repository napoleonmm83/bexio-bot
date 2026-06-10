import { expect, test, describe } from 'bun:test';
import { isAnotherRunInFlight } from './run.ts';

describe('isAnotherRunInFlight — cron/CLI in-flight guard (EDGE-5)', () => {
  const now = 1_700_000_000_000;
  const staleMs = 2 * 60 * 60 * 1000;

  test('no in-flight row → not blocked', () => {
    expect(isAnotherRunInFlight(null, now, staleMs)).toBe(false);
  });

  test('a fresh in-flight run → blocked', () => {
    expect(isAnotherRunInFlight(new Date(now - 60_000), now, staleMs)).toBe(true);
  });

  test('a stale in-flight run (older than cutoff) → not blocked (treated as dead)', () => {
    expect(isAnotherRunInFlight(new Date(now - 3 * 60 * 60 * 1000), now, staleMs)).toBe(false);
  });

  test('exactly at the cutoff → not blocked (boundary)', () => {
    expect(isAnotherRunInFlight(new Date(now - staleMs), now, staleMs)).toBe(false);
  });
});
