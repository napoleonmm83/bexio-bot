// TV-Rheintal billing rules — pure, deterministic, no I/O.
// A contribution finished on day 1–8 belongs to the previous month's invoice;
// the invoice for billing month X is dated the 1st of X+1 (due date: see dueDateFor).

export type Ymd = { year: number; month: number; day: number };
export type YearMonth = { year: number; month: number };

export type TvrInvoice = {
  id: number;
  isDraft: boolean;
  invoiceDate: string; // 'YYYY-MM-DD'
  positionTexts: string[];
};

export const SEND_WINDOW_LAST_DAY = 8;
export const POSITION_PREFIX = 'Video Beitrag TV Rheintal — ';
export const ALREADY_SENT_NOTE = 'Vormonatsrechnung bereits versendet, Beitrag auf Folgerechnung gebucht';

const pad = (n: number) => String(n).padStart(2, '0');
const prevMonth = ({ year, month }: YearMonth): YearMonth =>
  month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

export function isSendWindow(today: Ymd): boolean {
  return today.day <= SEND_WINDOW_LAST_DAY;
}

export function billingMonthFor(d: Ymd): YearMonth {
  return isSendWindow(d) ? prevMonth(d) : { year: d.year, month: d.month };
}

export function invoiceDateFor({ year, month }: YearMonth): string {
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

/** bexio's is_valid_to: the invoice day counts as day 1 (RE-00284: 01.11. → 30.11.). */
export function dueDateFor(invoiceDate: string, days = 30): string {
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
}

export function positionText(title: string): string {
  return `${POSITION_PREFIX}${title.trim()}`;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", szlig: 'ß', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', euro: '€',
};
// Accented letters: &<letter><mark>; → letter + combining mark, composed via NFC.
const MARKS: Record<string, string> = {
  uml: '̈', acute: '́', grave: '̀', circ: '̂', tilde: '̃', ring: '̊', cedil: '̧',
};

/** bexio returns position text as HTML (`<span>… &mdash;&nbsp; Holzr&uuml;cker</span>`). */
export function htmlToText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([A-Za-z])(uml|acute|grave|circ|tilde|ring|cedil);/g, (_, ch, mark) => ch + MARKS[mark])
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m)
    .normalize('NFC');
}

export function normalizeTitle(s: string): string {
  return htmlToText(s)
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[‒-―−]/g, '-')
    // Quote style is typing noise for dedup: «x», „x“, "x" and x are the same title.
    .replace(/["«»‹›„“”‚‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type AddPlan =
  | { action: 'already_exists'; invoiceId: number; invoiceDate: string; sendDue: boolean; note?: string }
  | { action: 'add'; invoiceId: number; invoiceDate: string; sendDue: boolean; note?: string }
  | { action: 'create'; invoiceDate: string; sendDue: boolean; note?: string };

/**
 * Decide where a contribution goes. `invoices` = all TV-Rheintal invoices of the
 * recent months (any status) — the duplicate check spans all of them.
 */
export function planAdd(input: { title: string; completion: Ymd; today: Ymd; invoices: TvrInvoice[] }): AddPlan {
  const { completion, today, invoices } = input;
  const wanted = normalizeTitle(positionText(input.title));
  const byDate = (date: string) => invoices.find((i) => i.invoiceDate === date);

  const dup = invoices.find((i) => i.positionTexts.some((t) => normalizeTitle(t) === wanted));
  if (dup) {
    return { action: 'already_exists', invoiceId: dup.id, invoiceDate: dup.invoiceDate, sendDue: sendDueFor(dup, today) };
  }

  const { invoiceDate, note } = targetFor(completion, invoices);
  const target = byDate(invoiceDate);
  if (!target) {
    // A freshly created invoice is a draft by construction.
    const created: TvrInvoice = { id: 0, isDraft: true, invoiceDate, positionTexts: [] };
    return { action: 'create', invoiceDate, sendDue: sendDueFor(created, today), note };
  }
  return { action: 'add', invoiceId: target.id, invoiceDate, sendDue: sendDueFor(target, today), note };
}

/** Which invoice date a contribution finished on `completion` belongs to. */
export function targetFor(completion: Ymd, invoices: TvrInvoice[]): { invoiceDate: string; note?: string } {
  let month = billingMonthFor(completion);
  let note: string | undefined;
  // An already-sent invoice is never a target: move on to the following one until a
  // draft (or no invoice yet) is found. Bounded — the caller only knows a few months.
  for (let i = 0; i <= invoices.length; i++) {
    const existing = invoices.find((inv) => inv.invoiceDate === invoiceDateFor(month));
    if (!existing || existing.isDraft) break;
    month = month.month === 12 ? { year: month.year + 1, month: 1 } : { year: month.year, month: month.month + 1 };
    note = ALREADY_SENT_NOTE;
  }
  return { invoiceDate: invoiceDateFor(month), note };
}

/** Due = we're in the 1–8 window and the invoice is last month's (dated the 1st of this month), still a draft. */
export function sendDueFor(inv: TvrInvoice, today: Ymd): boolean {
  return isSendWindow(today) && inv.isDraft && inv.invoiceDate === `${today.year}-${pad(today.month)}-01`;
}
