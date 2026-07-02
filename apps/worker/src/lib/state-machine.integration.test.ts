// Integration tests that drive processOrder / retryIssuedRows end-to-end with the
// bexio client mocked and a tiny per-test fake db. ONE mock.module for the whole
// file (two files mocking the same specifier would clobber each other globally).
//
// The stubs delegate to a mutable `stub` object so each test sets only what it
// needs; beforeEach resets to loud defaults so an un-stubbed call fails fast.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import * as bexio from '@bexio-bot/bexio-client';
import { formatBillingPeriod } from './billing-period.ts';
import { computeCurrentOccurrence } from './next-billing.ts';

type AnyFn = (...args: unknown[]) => unknown;
const notStubbed = (name: string): AnyFn => () => {
  throw new Error(`${name} called but not stubbed in this test`);
};

const stub: Record<string, AnyFn> = {};
function resetStubs() {
  stub.getOrderRepetition = notStubbed('getOrderRepetition');
  stub.createInvoiceFromOrder = notStubbed('createInvoiceFromOrder');
  stub.createInvoiceFromOrderSnapshot = notStubbed('createInvoiceFromOrderSnapshot');
  stub.findInvoiceByApiReference = (async () => null) as AnyFn;
  stub.issueInvoice = (async () => undefined) as AnyFn;
  stub.sendInvoice = (async () => undefined) as AnyFn;
  stub.getInvoice = notStubbed('getInvoice');
}
resetStubs();
beforeEach(resetStubs);

mock.module('@bexio-bot/bexio-client', () => ({
  ...bexio,
  getOrderRepetition: (...a: unknown[]) => stub.getOrderRepetition(...a),
  createInvoiceFromOrder: (...a: unknown[]) => stub.createInvoiceFromOrder(...a),
  createInvoiceFromOrderSnapshot: (...a: unknown[]) => stub.createInvoiceFromOrderSnapshot(...a),
  findInvoiceByApiReference: (...a: unknown[]) => stub.findInvoiceByApiReference(...a),
  issueInvoice: (...a: unknown[]) => stub.issueInvoice(...a),
  sendInvoice: (...a: unknown[]) => stub.sendInvoice(...a),
  getInvoice: (...a: unknown[]) => stub.getInvoice(...a),
}));

describe('processOrder — billing_period stays occurrence-anchored, never migrated to is_valid_from (Finding 1 / N-2)', () => {
  test('monthly first invoice: returns the occurrence period, not the is_valid_from period', async () => {
    const { processOrder } = await import('./state-machine.ts');

    const NOW = new Date();
    const rep = { start: NOW.toISOString(), repetition: { type: 'monthly', interval: 1 } };
    stub.getOrderRepetition = (async () => rep) as AnyFn;
    stub.createInvoiceFromOrder = (async () => ({
      id: 999, total: '189.00', is_valid_from: '2020-01-15', document_nr: 'RE-TEST',
    })) as AnyFn;

    const occurrence = computeCurrentOccurrence(rep, NOW);
    expect(occurrence).not.toBeNull();
    const expectedPeriod = formatBillingPeriod(occurrence!.toISOString(), 'monthly');
    expect(expectedPeriod).not.toBe(formatBillingPeriod('2020-01-15', 'monthly'));

    const updates: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ orderId: 5, status: 'creating', invoiceId: null }] }) }) }),
      update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { updates.push(p); } }) }),
    } as never;

    const result = await processOrder(
      db, 'fake-token',
      { bexioOrderId: 5, customerName: 'Regression Order', customerEmail: null },
      { mailSubject: 's', mailMessage: 'm', dueWindowDays: 3, autoSend: false },
    );

    expect(result.kind).toBe('created_unsent');
    if (result.kind !== 'created_unsent') throw new Error('unreachable');
    expect(result.billingPeriod).toBe(expectedPeriod);
    const createdWrite = updates.find((u) => u.status === 'created');
    expect(createdWrite).toBeDefined();
    expect(createdWrite!.billingPeriod).toBeUndefined();
  });
});

describe('retryIssuedRows — attempts counts REAL sends, not batch-claim (A1)', () => {
  // The claim UPDATE must NOT pre-bump attempts. Otherwise a crash mid-loop leaves
  // un-sent rows at attempts>0 → reconcileInFlightSends assumes them sent (BUG-2
  // class). attempts must be bumped per-row immediately before sendInvoice.
  test('claim does not set attempts; the bump happens before sendInvoice', async () => {
    const { retryIssuedRows } = await import('./state-machine.ts');

    stub.getInvoice = (async () => ({ id: 500, is_sent: false, mail_sent_at: null, document_nr: 'RE-1' })) as AnyFn;
    const sendCalls: number[] = [];

    const updates: Array<{ payload: Record<string, unknown>; returning: boolean }> = [];
    stub.sendInvoice = (async () => { sendCalls.push(updates.length); }) as AnyFn;

    const db = {
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => { updates.push({ payload, returning: true }); return [{ orderId: 5, billingPeriod: '2026-07', status: 'sending', invoiceId: 500, attempts: 0 }]; },
            then: (res: (v: unknown) => void) => { updates.push({ payload, returning: false }); res(undefined); },
          }),
        }),
      }),
      select: () => ({ from: () => ({ where: async () => [{ bexioOrderId: 5, customerEmail: 'k@example.ch' }] }) }),
    } as never;

    await retryIssuedRows(db, 'fake-token', { mailSubject: 's', mailMessage: 'm' }, false);

    // The atomic batch claim (the UPDATE ... RETURNING) must NOT carry attempts.
    const claim = updates.find((u) => u.returning);
    expect(claim).toBeDefined();
    expect(claim!.payload.attempts).toBeUndefined();

    // attempts must be bumped (an UPDATE whose payload sets attempts) BEFORE the send.
    const bumpIdx = updates.findIndex((u) => u.payload.attempts !== undefined);
    expect(bumpIdx).toBeGreaterThanOrEqual(0);
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]).toBeGreaterThan(bumpIdx);
  });
});
