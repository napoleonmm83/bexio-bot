import { expect, test, describe } from 'bun:test';
import {
  shouldSnapshotFallback,
  interpretClaimResult,
  reconcileInFlightSends,
  retryIssuedRows,
  classifyStuckSendingRow,
  shouldResendIssuedRow,
} from './state-machine.ts';

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

describe('dry-run safety — crash recovery must not touch the DB or send (BUG-1)', () => {
  // A db whose every property access throws. If either recovery stage reaches
  // the database in dry-run, the test fails loudly — proving no invoice can be
  // re-sent and no invoice_runs row mutated during a "safe preview" run.
  const guardDb = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`DB accessed during dry-run via db.${String(prop)}`);
      },
    },
  ) as never;

  test('reconcileInFlightSends in dry-run returns zeros without DB access', async () => {
    const result = await reconcileInFlightSends(guardDb, 'fake-token', true);
    expect(result).toEqual({ reconciledSent: 0, reconciledAssumedSent: 0, reconciledIssued: 0, reconciledFailed: 0 });
  });

  test('retryIssuedRows in dry-run returns 0 without DB access', async () => {
    const result = await retryIssuedRows(guardDb, 'fake-token', {} as never, true);
    expect(result).toBe(0);
  });
});

describe('classifyStuckSendingRow — crash-recovery decision for stale sending rows (BUG-2, BUG-7)', () => {
  test('bexio confirms is_sent → confirmed-sent', () => {
    expect(classifyStuckSendingRow({ liveIsSent: true, liveMailSentAt: null, attempts: 1 })).toBe('confirmed-sent');
  });

  test('bexio mail_sent_at present → confirmed-sent (even with attempts 0)', () => {
    expect(classifyStuckSendingRow({ liveIsSent: false, liveMailSentAt: '2026-06-10', attempts: 0 })).toBe('confirmed-sent');
  });

  test('not confirmed but a send WAS attempted (attempts>0) → assumed-sent (N-5 anti-duplicate)', () => {
    expect(classifyStuckSendingRow({ liveIsSent: false, liveMailSentAt: null, attempts: 1 })).toBe('assumed-sent');
    expect(classifyStuckSendingRow({ liveIsSent: false, liveMailSentAt: null, attempts: 3 })).toBe('assumed-sent');
  });

  test('crashed BEFORE the send was attempted (attempts===0) → retry, not falsely sent', () => {
    expect(classifyStuckSendingRow({ liveIsSent: false, liveMailSentAt: null, attempts: 0 })).toBe('retry');
  });
});

describe('shouldResendIssuedRow — honor bexio sent flags before re-mailing (BUG-3)', () => {
  test('bexio already marks is_sent → do NOT resend', () => {
    expect(shouldResendIssuedRow({ is_sent: true })).toBe(false);
  });

  test('mail_sent_at present → do NOT resend', () => {
    expect(shouldResendIssuedRow({ mail_sent_at: '2026-06-10T08:00:00Z' })).toBe(false);
  });

  test('neither flag set → resend', () => {
    expect(shouldResendIssuedRow({ is_sent: false, mail_sent_at: null })).toBe(true);
    expect(shouldResendIssuedRow({})).toBe(true);
  });
});
