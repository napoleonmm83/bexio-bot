import { describe, expect, test } from 'bun:test';
import type { BexioInvoice } from '@bexio-bot/bexio-client';
import { formatOverdue, zurichToday } from './overdue.ts';

const inv = (over: Partial<BexioInvoice>): BexioInvoice => ({
  id: 1,
  document_nr: 'RE-00001',
  title: '',
  contact_id: 42,
  total: '100.00',
  is_valid_from: '2026-09-01',
  is_valid_to: '2026-10-01',
  kb_item_status_id: 8,
  updated_at: '2026-10-01 00:00:00',
  ...over,
});

describe('formatOverdue', () => {
  test('due today is not overdue, due yesterday is 1 Tag', () => {
    const lines = formatOverdue(
      [inv({ document_nr: 'RE-1', is_valid_to: '2026-10-22' }), inv({ document_nr: 'RE-2', is_valid_to: '2026-10-21' })],
      '2026-10-22',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('RE-2');
    expect(lines[0]).toEndWith('1 Tag überfällig');
  });

  test('sorts most overdue first and uses remaining amount + first address line', () => {
    const lines = formatOverdue(
      [
        inv({ document_nr: 'RE-A', is_valid_to: '2026-10-12', contact_address: 'Firma A\nStrasse 1' }),
        inv({ document_nr: 'RE-B', is_valid_to: '2026-09-22', total: '500.00', total_remaining_payments: '250.00' }),
      ],
      '2026-10-22',
    );
    expect(lines[0]).toStartWith('RE-B');
    expect(lines[0]).toContain('250.00');
    expect(lines[0]).toContain('Kontakt #42');
    expect(lines[0]).toEndWith('30 Tage überfällig');
    expect(lines[1]).toContain('Firma A ·');
  });
});

describe('zurichToday', () => {
  test('22:30 UTC is already the next day in Zurich (summer time)', () => {
    expect(zurichToday(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02');
  });
});
