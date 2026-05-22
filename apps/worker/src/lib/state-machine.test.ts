import { expect, test, describe } from 'bun:test';
import { shouldSnapshotFallback } from './state-machine.ts';

describe('shouldSnapshotFallback — only daily/weekly trigger snapshot path', () => {
  test('daily order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('daily')).toBe(true);
  });

  test('weekly order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('weekly')).toBe(true);
  });

  test('monthly order with 422 fully-invoiced → NOT snapshot (treat as not_due)', () => {
    expect(shouldSnapshotFallback('monthly')).toBe(false);
  });

  test('yearly order with 422 fully-invoiced → NOT snapshot', () => {
    expect(shouldSnapshotFallback('yearly')).toBe(false);
  });

  test('unknown / undefined type → NOT snapshot (fail-closed)', () => {
    expect(shouldSnapshotFallback(undefined)).toBe(false);
    expect(shouldSnapshotFallback('something-weird')).toBe(false);
  });
});
