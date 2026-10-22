import { describe, expect, test } from 'bun:test';
import {
  billingMonthFor,
  dueDateFor,
  findPositionByTitle,
  invoiceDateFor,
  normalizeTitle,
  planAdd,
  positionText,
  sendDueFor,
  titleChanged,
  type TvrInvoice,
} from './tvr-billing';

const ymd = (s: string) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};

describe('billingMonthFor', () => {
  test.each([
    ['2026-11-01', '2026-10'],
    ['2026-11-08', '2026-10'],
    ['2026-11-09', '2026-11'],
    ['2026-10-31', '2026-10'],
    ['2026-10-22', '2026-10'],
    ['2027-01-05', '2026-12'],
  ])('%s → %s', (d, expected) => {
    const bm = billingMonthFor(ymd(d));
    expect(`${bm.year}-${String(bm.month).padStart(2, '0')}`).toBe(expected);
  });
});

test('invoice date is the 1st of the following month, due +30 days', () => {
  expect(invoiceDateFor({ year: 2026, month: 10 })).toBe('2026-11-01');
  expect(invoiceDateFor({ year: 2026, month: 12 })).toBe('2027-01-01');
  // bexio counts the invoice day itself: RE-00284 is valid 2026-11-01 → 2026-11-30.
  expect(dueDateFor('2026-11-01')).toBe('2026-11-30');
  expect(dueDateFor('2027-02-01')).toBe('2027-03-02');
});

test('normalizeTitle treats dash variants, case and whitespace alike', () => {
  expect(normalizeTitle('  Video Beitrag TV Rheintal — Kuhrennen ')).toBe(
    normalizeTitle('video beitrag tv rheintal - kuhrennen'),
  );
  expect(normalizeTitle('Kuh–Rennen')).toBe('kuh-rennen');
});

test('normalizeTitle matches bexio HTML position text (real RE-00284 shape)', () => {
  expect(normalizeTitle('<span>Video Beitrag TV Rheintal &mdash;&nbsp; Kuhrennen</span>')).toBe(
    normalizeTitle('Video Beitrag TV Rheintal — Kuhrennen'),
  );
  expect(normalizeTitle('<span>Video Beitrag TV Rheintal &mdash;&nbsp; Holzr&uuml;cker</span>')).toBe(
    normalizeTitle('Video Beitrag TV Rheintal — Holzrücker'),
  );
});

const draft = (date: string, titles: string[] = []): TvrInvoice => ({
  id: Number(date.replaceAll('-', '')),
  isDraft: true,
  invoiceDate: date,
  positionTexts: titles,
});

describe('planAdd (spec table)', () => {
  test('22.10. → October invoice (01.11.), not due', () => {
    const p = planAdd({ title: 'Kuhrennen', completion: ymd('2026-10-22'), today: ymd('2026-10-22'), invoices: [] });
    expect(p).toMatchObject({ action: 'create', invoiceDate: '2026-11-01', sendDue: false });
  });

  test('03.11. → October invoice, send window open', () => {
    const p = planAdd({
      title: 'Kuhrennen',
      completion: ymd('2026-11-03'),
      today: ymd('2026-11-03'),
      invoices: [draft('2026-11-01', ['Video Beitrag TV Rheintal — Alpabzug'])],
    });
    expect(p).toMatchObject({ action: 'add', invoiceId: 20261101, invoiceDate: '2026-11-01', sendDue: true });
  });

  test('12.11. → November invoice (01.12.), not due', () => {
    const p = planAdd({ title: 'X', completion: ymd('2026-11-12'), today: ymd('2026-11-12'), invoices: [] });
    expect(p).toMatchObject({ action: 'create', invoiceDate: '2026-12-01', sendDue: false });
  });
});

test('previous-month invoice already sent → books on the follow-up invoice with note', () => {
  const sent: TvrInvoice = { ...draft('2026-11-01'), isDraft: false };
  const p = planAdd({ title: 'Neu', completion: ymd('2026-11-04'), today: ymd('2026-11-04'), invoices: [sent] });
  expect(p).toMatchObject({ action: 'create', invoiceDate: '2026-12-01', sendDue: false });
  expect(p.note).toBe('Vormonatsrechnung bereits versendet, Beitrag auf Folgerechnung gebucht');
});

test('duplicate in any recent invoice (also a sent one) → already_exists', () => {
  const sent: TvrInvoice = { ...draft('2026-11-01', ['Video Beitrag TV Rheintal - kuhrennen']), isDraft: false };
  const p = planAdd({ title: 'Kuhrennen', completion: ymd('2026-11-15'), today: ymd('2026-11-15'), invoices: [sent] });
  expect(p).toMatchObject({ action: 'already_exists', invoiceId: sent.id });
});

test('review #1: day > 8 and this month\'s invoice already sent → next invoice, never the sent one', () => {
  const sent: TvrInvoice = { ...draft('2026-11-01'), isDraft: false };
  const p = planAdd({ title: 'X', completion: ymd('2026-10-22'), today: ymd('2026-11-12'), invoices: [sent] });
  expect(p).toMatchObject({ action: 'create', invoiceDate: '2026-12-01' });
});

test('target is never a non-draft, even if several following invoices are already sent', () => {
  const s1: TvrInvoice = { ...draft('2026-11-01'), isDraft: false };
  const s2: TvrInvoice = { ...draft('2026-12-01'), isDraft: false };
  const p = planAdd({ title: 'X', completion: ymd('2026-11-03'), today: ymd('2026-11-03'), invoices: [s1, s2] });
  expect(p).toMatchObject({ action: 'create', invoiceDate: '2027-01-01' });
});

test('sendDue is false for an already-sent invoice dated the 1st of this month', () => {
  const sent: TvrInvoice = { ...draft('2026-11-01'), isDraft: false };
  expect(sendDueFor(sent, ymd('2026-11-03'))).toBe(false);
});

test('review #3: guillemets, curly quotes, apostrophes and accents dedupe against bexio entities', () => {
  const pairs: [string, string][] = [
    ['<span>Video Beitrag TV Rheintal &mdash;&nbsp; &laquo;Kuhrennen&raquo;</span>', 'Video Beitrag TV Rheintal — «Kuhrennen»'],
    ['&bdquo;Alpabzug&ldquo;', '„Alpabzug“'],
    ['D&rsquo;Alp', "D'Alp"],
    ['Ch&acirc;teau &Uuml;berraschung', 'Château Überraschung'],
    ['Caf&eacute; &amp; Co', 'Café & Co'],
  ];
  for (const [html, typed] of pairs) expect(normalizeTitle(html)).toBe(normalizeTitle(typed));
});

test('bug report §4: two spaces after the dash (bexio UI) equal one space (bot)', () => {
  expect(normalizeTitle('<span>Video Beitrag TV Rheintal &mdash;&nbsp; Kuhrennen</span>')).toBe(
    normalizeTitle('Video Beitrag TV Rheintal — Kuhrennen'),
  );
  expect(normalizeTitle('Video Beitrag TV Rheintal —  Kuhrennen')).toBe(normalizeTitle('Video Beitrag TV Rheintal — Kuhrennen'));
});

test('review F1: a title that already carries the prefix is not prefixed twice', () => {
  expect(positionText('Video Beitrag TV Rheintal — Kuhrennen')).toBe('Video Beitrag TV Rheintal — Kuhrennen');
  expect(positionText('<span>Video Beitrag TV Rheintal &mdash;&nbsp; Kuhrennen</span>')).toBe(
    'Video Beitrag TV Rheintal — Kuhrennen',
  );
  expect(positionText('video beitrag tv rheintal - Kuhrennen')).toBe('Video Beitrag TV Rheintal — Kuhrennen');
  expect(positionText('  Kuhrennen ')).toBe('Video Beitrag TV Rheintal — Kuhrennen');
});

test('review F2: titleChanged sees case/quote/dash-only corrections as a change', () => {
  expect(titleChanged('kuhrennen', 'Kuhrennen')).toBe(true);
  expect(titleChanged('Kuh-Rennen', 'Kuh–Rennen')).toBe(true);
  expect(titleChanged('Kuhrennen', 'Video Beitrag TV Rheintal — Kuhrennen')).toBe(false);
});

describe('findPositionByTitle (rename/remove address by the title the user sees)', () => {
  const inv = (id: number, isDraft: boolean, texts: [number, string][]) => ({
    id,
    isDraft,
    positions: texts.map(([pid, text]) => ({ id: pid, text })),
  });
  const re284 = inv(284, true, [
    [534, '<span>Video Beitrag TV Rheintal &mdash;&nbsp; Heimmatb&uuml;hne Werdenberg</span>'],
    [539, '<span>Video Beitrag TV Rheintal &mdash;&nbsp; Kuhrennen</span>'],
    [540, 'Video Beitrag TV Rheintal — Heimatbühne Werdenberg'],
  ]);

  test('exactly one match → ref with invoice + position id', () => {
    expect(findPositionByTitle([re284], 'Heimmatbühne Werdenberg')).toEqual({
      kind: 'one',
      ref: { invoiceId: 284, positionId: 534, text: re284.positions[0].text },
    });
  });
  test('the full position text also matches', () => {
    expect(findPositionByTitle([re284], 'Video Beitrag TV Rheintal — Kuhrennen')).toMatchObject({ kind: 'one' });
  });
  test('no match → none; a near miss is NOT a match', () => {
    expect(findPositionByTitle([re284], 'Kuhrenen')).toEqual({ kind: 'none' });
  });
  test('two matches (duplicate rows) → many, never pick one', () => {
    const dup = inv(300, true, [[1, 'Video Beitrag TV Rheintal — Kuhrennen']]);
    expect(findPositionByTitle([re284, dup], 'Kuhrennen')).toMatchObject({ kind: 'many' });
  });
  test('review F5 (by design): same title on a sent AND a draft invoice → the draft is the target', () => {
    const sent = inv(250, false, [[9, 'Video Beitrag TV Rheintal — Kuhrennen']]);
    expect(findPositionByTitle([sent, re284], 'Kuhrennen')).toMatchObject({ kind: 'one', ref: { positionId: 539 } });
  });
  test('excludePositionId: the renamed position itself is not a clash', () => {
    expect(findPositionByTitle([re284], 'Kuhrennen', { excludePositionId: 539 })).toEqual({ kind: 'none' });
  });
  test('positions on sent invoices are never touched', () => {
    const sent = inv(250, false, [[9, 'Video Beitrag TV Rheintal — Alpabzug']]);
    expect(findPositionByTitle([sent], 'Alpabzug')).toEqual({ kind: 'not_draft', invoiceId: 250 });
  });
});

test('03.11. without any October invoice yet → create, and it is due', () => {
  const p = planAdd({ title: 'A', completion: ymd('2026-11-03'), today: ymd('2026-11-03'), invoices: [] });
  expect(p).toMatchObject({ action: 'create', invoiceDate: '2026-11-01', sendDue: true });
});

test('sendDue only for the previous-month draft inside the window', () => {
  // Completion late in month but run on the 2nd: target is next invoice, not due.
  const p = planAdd({ title: 'A', completion: ymd('2026-10-25'), today: ymd('2026-11-02'), invoices: [draft('2026-11-01')] });
  expect(p).toMatchObject({ action: 'add', invoiceDate: '2026-11-01', sendDue: true });
  const q = planAdd({ title: 'A', completion: ymd('2026-11-01'), today: ymd('2026-11-09'), invoices: [draft('2026-11-01')] });
  expect(q.sendDue).toBe(false);
});
