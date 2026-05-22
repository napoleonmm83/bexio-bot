import { expect, test, describe } from 'bun:test';
import { shouldSnapshotFallback, interpretClaimResult } from './state-machine.ts';

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

describe('interpretClaimResult — claim-row race interpretation', () => {
  test('claim insert returned a row → we own the slot', () => {
    const result = interpretClaimResult([{ orderId: 13, status: 'creating', invoiceId: null }], null);
    expect(result.kind).toBe('own');
  });

  test('claim insert returned nothing, existing row has invoice_id → duplicate', () => {
    const result = interpretClaimResult(
      [],
      { orderId: 13, invoiceId: 234, billingPeriod: '2026-05-22' },
    );
    expect(result).toEqual({
      kind: 'duplicate',
      existingInvoiceId: 234,
      billingPeriod: '2026-05-22',
    });
  });

  test('claim insert returned nothing, existing row in-flight (no invoice_id) → backoff', () => {
    const result = interpretClaimResult(
      [],
      { orderId: 13, invoiceId: null, billingPeriod: '2026-05-22', status: 'creating' },
    );
    expect(result.kind).toBe('concurrent-in-flight');
  });
});
