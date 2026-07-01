import { expect, test, describe } from 'bun:test';
import { isAnotherRunInFlight, collectBillingAnomalies } from './run.ts';
import type { ProcessOrderResult } from './state-machine.ts';

const mk = (orderId: number, customerName: string, result: ProcessOrderResult) => ({ orderId, customerName, result });

describe('collectBillingAnomalies — surfaces due-but-unbilled orders (silent-skip guard)', () => {
  test('sent / created_unsent / skipped_duplicate → no anomaly', () => {
    const results = [
      mk(1, 'A', { kind: 'sent', invoiceId: 1, amount: '10', billingPeriod: '2026-06' }),
      mk(2, 'B', { kind: 'created_unsent', invoiceId: 2, amount: '10', billingPeriod: '2026-06' }),
      mk(3, 'C', { kind: 'skipped_duplicate', existingInvoiceId: 3, billingPeriod: '2026-06' }),
    ];
    expect(collectBillingAnomalies(results)).toEqual([]);
  });

  test('genuine not_due (not scheduled) → no anomaly', () => {
    expect(collectBillingAnomalies([mk(1, 'A', { kind: 'not_due', reason: 'not due today' })])).toEqual([]);
  });

  test('a not_due that happened despite the order being due (swallowed bexio 422) → anomaly', () => {
    const anomalies = collectBillingAnomalies([
      mk(5, 'Restaurant Vivid', { kind: 'not_due', reason: 'does not contain any valid positions', wasDue: true }),
    ]);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]!.orderId).toBe(5);
    expect(anomalies[0]!.customerName).toBe('Restaurant Vivid');
  });

  test('failed → anomaly', () => {
    expect(collectBillingAnomalies([mk(7, 'D', { kind: 'failed', reason: 'send failed' })]).length).toBe(1);
  });

  test('skipped_unsupported → no anomaly (surfaced separately via unsupportedOrders)', () => {
    expect(collectBillingAnomalies([mk(8, 'E', { kind: 'skipped_unsupported', bexioType: 'custom' })])).toEqual([]);
  });

  test('mixed batch → only the two real anomalies', () => {
    const anomalies = collectBillingAnomalies([
      mk(1, 'A', { kind: 'sent', invoiceId: 1, amount: '10', billingPeriod: '2026-06' }),
      mk(5, 'Vivid', { kind: 'not_due', reason: 'exhausted', wasDue: true }),
      mk(6, 'F', { kind: 'not_due', reason: 'not due today' }),
      mk(7, 'G', { kind: 'failed', reason: 'boom' }),
    ]);
    expect(anomalies.map((a) => a.orderId).sort()).toEqual([5, 7]);
  });
});

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
