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

  test('preserves KbPositionText heading lines in place (invoice matches order layout)', () => {
    const order: BexioOrder = {
      id: 5,
      document_nr: 'AU-00005',
      title: '',
      contact_id: 221,
      user_id: 1,
      total: '189.000000',
      mwst_type: 2,
      mwst_is_net: true,
      is_recurring: true,
      updated_at: '2026-07-01 00:00:00',
      positions: [
        { id: 1, type: 'KbPositionCustom', amount: '1.000000', tax_id: null, text: 'Administrative Service', unit_price: '100.000000', is_optional: false },
        { id: 2, type: 'KbPositionText', text: 'Resmio Reservationstool Monatsabo', is_optional: false },
        { id: 3, type: 'KbPositionCustom', amount: '1.000000', tax_id: null, text: 'Resmio Webreservation', unit_price: '69.000000', is_optional: false },
      ],
    };

    expect(buildCreateInvoiceInputFromOrder(order, '2026-06-30', 'ref').positions).toEqual([
      { type: 'KbPositionCustom', amount: '1.000000', tax_id: 28, text: 'Administrative Service', unit_price: '100.000000' },
      { type: 'KbPositionText', text: 'Resmio Reservationstool Monatsabo' },
      { type: 'KbPositionCustom', amount: '1.000000', tax_id: 28, text: 'Resmio Webreservation', unit_price: '69.000000' },
    ]);
  });

  test('throws when the order has only text positions (no chargeable line)', () => {
    const order: BexioOrder = {
      id: 77,
      document_nr: 'AU-00077',
      title: '',
      contact_id: 1,
      user_id: 1,
      total: '0',
      is_recurring: true,
      updated_at: '2026-07-01 00:00:00',
      positions: [{ id: 1, type: 'KbPositionText', text: 'just a heading', is_optional: false }],
    };
    expect(() => buildCreateInvoiceInputFromOrder(order, '2026-06-30')).toThrow(/no invoiceable positions/);
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
