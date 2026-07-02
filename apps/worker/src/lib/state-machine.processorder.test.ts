// Regression test for the N-2 period-key double-bill (Finding 1, 2026-07-02).
//
// processOrder used to MIGRATE the invoice_runs (order_id, billing_period) PK
// from the occurrence-anchored key to one derived from bexio's invoice.is_valid_from.
// For a monthly/yearly FIRST invoice (order path) whose is_valid_from bexio set to
// a different period, that freed the occurrence key — so a later run inside the
// catch-up window re-computed the occurrence key, found no row, and billed the
// SAME occurrence a second time → duplicate invoice + email.
//
// This test drives processOrder end-to-end (bexio client mocked, a tiny fake db)
// and asserts the persisted/returned billing_period stays anchored to the
// OCCURRENCE regardless of is_valid_from. It is time-robust: the expected period
// is derived from the same computeCurrentOccurrence processOrder uses, and
// is_valid_from is deliberately set to an unrelated period.

import { describe, test, expect, mock } from 'bun:test';
import * as bexio from '@bexio-bot/bexio-client';
import { formatBillingPeriod } from './billing-period.ts';
import { computeCurrentOccurrence } from './next-billing.ts';

// A monthly order whose current occurrence is "today" (start = today → occurrence
// = today, diff 0, well inside the default 3-day due window).
const NOW = new Date();
const TODAY_ISO = NOW.toISOString();
const MONTHLY_REP = { start: TODAY_ISO, repetition: { type: 'monthly', interval: 1 } };

// bexio-assigned is_valid_from in a deliberately DIFFERENT period than any 2026
// occurrence — this is exactly what triggered the migration.
const IS_VALID_FROM_OTHER_PERIOD = '2020-01-15';

mock.module('@bexio-bot/bexio-client', () => ({
  ...bexio,
  getOrderRepetition: async () => MONTHLY_REP,
  createInvoiceFromOrder: async () => ({
    id: 999,
    total: '189.00',
    is_valid_from: IS_VALID_FROM_OTHER_PERIOD,
    document_nr: 'RE-TEST',
  }),
}));

/**
 * Minimal fake db covering only what the auto_send=false path touches:
 *   insert().values().onConflictDoNothing().returning()  → claim won
 *   update().set().where()                                → capture the payload
 * (no select/delete on this path). where-conditions are ignored — the scenario is
 * deterministic and single-row.
 */
function makeFakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [{ orderId: 5, status: 'creating', invoiceId: null }],
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => {
          updates.push(payload);
        },
      }),
    }),
  } as never;
  return { db, updates };
}

describe('processOrder — billing_period stays occurrence-anchored, never migrated to is_valid_from (Finding 1)', () => {
  test('monthly first invoice: returns the occurrence period, not the is_valid_from period', async () => {
    const { processOrder } = await import('./state-machine.ts');

    const occurrence = computeCurrentOccurrence(MONTHLY_REP, NOW);
    expect(occurrence).not.toBeNull();
    const expectedPeriod = formatBillingPeriod(occurrence!.toISOString(), 'monthly');
    const isValidFromPeriod = formatBillingPeriod(IS_VALID_FROM_OTHER_PERIOD, 'monthly');
    // Guard the test's own premise: the two periods MUST differ or it proves nothing.
    expect(expectedPeriod).not.toBe(isValidFromPeriod);

    const { db, updates } = makeFakeDb();
    const result = await processOrder(
      db,
      'fake-token',
      { bexioOrderId: 5, customerName: 'Regression Order', customerEmail: null },
      { mailSubject: 's', mailMessage: 'm', dueWindowDays: 3, autoSend: false },
    );

    // auto_send off → invoice created as a draft, pipeline stops before issue/send.
    expect(result.kind).toBe('created_unsent');
    if (result.kind !== 'created_unsent') throw new Error('unreachable');

    // The regression: with the old migration this was isValidFromPeriod ('2020-01').
    expect(result.billingPeriod).toBe(expectedPeriod);

    // The persisted 'created' row must NOT rewrite the billing_period key.
    const createdWrite = updates.find((u) => u.status === 'created');
    expect(createdWrite).toBeDefined();
    expect(createdWrite!.billingPeriod).toBeUndefined();
  });
});
