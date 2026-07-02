import { expect, test, describe } from 'bun:test';
import { BexioApiError } from '@bexio-bot/bexio-client';
import {
  shouldSnapshotFallback,
  isOrderExhaustedError,
  interpretClaimResult,
  reconcileInFlightSends,
  reconcileStuckPreSendRows,
  retryIssuedRows,
  classifyStuckSendingRow,
  classifyStuckPreSendRow,
  shouldResendIssuedRow,
  shouldRefuseZeroAmountInvoice,
  shouldFailOnReadbackError,
} from './state-machine.ts';

describe('isOrderExhaustedError — 422s that mean "order endpoint exhausted, use snapshot"', () => {
  const err = (status: number, body: string) => new BexioApiError(status, 'permanent', body);

  test('422 "order is fully invoiced" → true', () => {
    expect(isOrderExhaustedError(err(422, 'The order is fully invoiced'))).toBe(true);
  });

  // The real message bexio returned for the stuck monthly order #5 — previously
  // unmatched, so it fell through to errorClass=permanent → not_due, and the
  // snapshot fallback was never attempted.
  test('422 "does not contain any valid positions" → true', () => {
    expect(
      isOrderExhaustedError(err(422, '{"error_code":422,"message":"the order does not contain any valid positions"}')),
    ).toBe(true);
  });

  test('an unrelated 422 → false (still a real error, not a snapshot trigger)', () => {
    expect(isOrderExhaustedError(err(422, 'some other validation error'))).toBe(false);
  });

  test('non-422 with the same text → false', () => {
    expect(isOrderExhaustedError(err(500, 'the order does not contain any valid positions'))).toBe(false);
  });
});

describe('shouldSnapshotFallback — every supported recurring type may snapshot', () => {
  test('daily order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('daily')).toBe(true);
  });

  test('weekly order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('weekly')).toBe(true);
  });

  // BUG: monthly orders billed exactly once (first invoice via
  // POST /kb_order/invoice), then every later occurrence hit 422 → not_due and
  // was silently skipped forever. isOrderDue + the (order_id, billing_period)
  // dedup already gate this path, so the snapshot is safe for monthly too.
  test('monthly order with 422 fully-invoiced → snapshot (was silently skipped)', () => {
    expect(shouldSnapshotFallback('monthly')).toBe(true);
  });

  // Quarterly / semi-annual arrive as bexio type 'monthly' (interval 3/6), so
  // 'monthly' covers them. 'yearly' is its own bexio type.
  test('yearly order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('yearly')).toBe(true);
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

  test('reconcileStuckPreSendRows in dry-run returns zeros without DB access', async () => {
    const result = await reconcileStuckPreSendRows(guardDb, 'fake-token', true, true);
    expect(result).toEqual({ reclaimed: 0, resumed: 0, leftDraft: 0, alertedDrafts: [] });
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

describe('classifyStuckPreSendRow — crash-recovery decision for stale creating/created/issuing rows', () => {
  // The narrow hard-kill: a crash between the claim INSERT (status='creating',
  // invoice_id=null) and the 'created' write. interpretClaimResult keys on
  // invoice_id, so every future run reads it as concurrent-in-flight and the
  // order silently never bills that period again. Reclaim (delete) → re-bill.
  test('creating + no invoice_id → reclaim (delete stale claim, re-bill)', () => {
    expect(classifyStuckPreSendRow({ status: 'creating', invoiceId: null, autoSend: true })).toBe('reclaim');
    expect(classifyStuckPreSendRow({ status: 'creating', invoiceId: null, autoSend: false })).toBe('reclaim');
  });

  // 'issuing' is only reached past the auto_send gate, and once an invoice is
  // festgeschrieben it must complete to sent — a customer is owed delivery. Resume
  // regardless of the current auto_send (mirrors retryIssuedRows).
  test('issuing + invoice_id → resume (regardless of auto_send)', () => {
    expect(classifyStuckPreSendRow({ status: 'issuing', invoiceId: 42, autoSend: true })).toBe('resume');
    expect(classifyStuckPreSendRow({ status: 'issuing', invoiceId: 42, autoSend: false })).toBe('resume');
  });

  // 'created' is a REVERSIBLE draft and a stable resting state — recovery must
  // NEVER auto-send it (an auto_send OFF→ON flip would then festschreiben+mail
  // every parked draft). But with auto_send ON, a stale 'created' row means a
  // crash between the create and issue writes → the occurrence was never sent, so
  // ALERT (B2/B1). With auto_send OFF it is an intentional parked draft → leave.
  test('created + invoice_id + auto_send on → alert (crash-created, never sent)', () => {
    expect(classifyStuckPreSendRow({ status: 'created', invoiceId: 42, autoSend: true })).toBe('alert');
  });
  test('created + invoice_id + auto_send off → leave (intentional parked draft)', () => {
    expect(classifyStuckPreSendRow({ status: 'created', invoiceId: 42, autoSend: false })).toBe('leave');
  });

  // Defensive: combinations the invariant forbids (invoice_id is set exactly at
  // the 'created' transition) must never take a destructive action.
  test('impossible combinations → leave (never delete/act on a row we can not reason about)', () => {
    expect(classifyStuckPreSendRow({ status: 'creating', invoiceId: 42, autoSend: true })).toBe('leave');
    expect(classifyStuckPreSendRow({ status: 'issuing', invoiceId: null, autoSend: true })).toBe('leave');
    expect(classifyStuckPreSendRow({ status: 'sent', invoiceId: 42, autoSend: true })).toBe('leave');
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

describe('shouldRefuseZeroAmountInvoice — never issue a CHF 0 / non-positive invoice (EDGE-3)', () => {
  test('zero, negative, and non-numeric totals are refused (fail-closed)', () => {
    for (const t of ['0', '0.00', '-5', '-0.01', 0, null, undefined, '', '  ', 'abc', NaN]) {
      expect(shouldRefuseZeroAmountInvoice(t)).toBe(true);
    }
  });

  test('positive totals are allowed', () => {
    for (const t of ['0.01', '10.00', '1500.50', 42]) {
      expect(shouldRefuseZeroAmountInvoice(t)).toBe(false);
    }
  });
});

describe('shouldFailOnReadbackError — only a 404 is a permanent reconcile failure (EDGE-4)', () => {
  test('bexio 404 (invoice gone) → permanent fail', () => {
    expect(shouldFailOnReadbackError(new BexioApiError(404, 'permanent', 'not found'))).toBe(true);
  });

  test('transient / auth / rate-limit / network → do NOT terminally fail (retry next run)', () => {
    expect(shouldFailOnReadbackError(new BexioApiError(500, 'transient', 'x'))).toBe(false);
    expect(shouldFailOnReadbackError(new BexioApiError(429, 'rate_limit', 'x'))).toBe(false);
    expect(shouldFailOnReadbackError(new BexioApiError(401, 'auth', 'x'))).toBe(false);
    expect(shouldFailOnReadbackError(new TypeError('network'))).toBe(false);
    expect(shouldFailOnReadbackError(new Error('weird'))).toBe(false);
  });
});
