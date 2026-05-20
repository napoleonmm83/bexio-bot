import { describe, expect, test } from 'bun:test';
import { buildCreateInvoiceInputFromOrder } from './invoices.ts';
import type { BexioOrder } from './types.ts';

describe('buildCreateInvoiceInputFromOrder', () => {
  test('copies custom positions from a fully invoiced recurring order snapshot', () => {
    const order: BexioOrder = {
      id: 13,
      document_nr: 'AU-00013',
      title: '',
      contact_id: 561,
      user_id: 1,
      total: '1.000000',
      mwst_type: 2,
      mwst_is_net: true,
      is_recurring: true,
      updated_at: '2026-05-11 00:12:49',
      positions: [
        {
          id: 428,
          type: 'KbPositionCustom',
          amount: '1.000000',
          account_id: 101,
          tax_id: null,
          text: 'test',
          unit_price: '1.000000',
          is_optional: false,
        },
      ],
    };

    expect(buildCreateInvoiceInputFromOrder(order, '2026-05-20', 'ref')).toEqual({
      contact_id: 561,
      user_id: 1,
      title: 'Auftrag AU-00013',
      is_valid_from: '2026-05-20',
      mwst_type: 2,
      mwst_is_net: true,
      api_reference: 'ref',
      positions: [
        {
          type: 'KbPositionCustom',
          amount: '1.000000',
          account_id: 101,
          tax_id: 28,
          text: 'test',
          unit_price: '1.000000',
        },
      ],
    });
  });

  test('throws when source order has no user_id', () => {
    const order: BexioOrder = {
      id: 99,
      document_nr: 'AU-00099',
      title: '',
      contact_id: 1,
      total: '0',
      is_recurring: true,
      updated_at: '2026-05-20 00:00:00',
      positions: [
        { id: 1, type: 'KbPositionCustom', amount: '1', account_id: 101, unit_price: '1', is_optional: false },
      ],
    };
    expect(() => buildCreateInvoiceInputFromOrder(order, '2026-05-20')).toThrow(/user_id/);
  });
});
