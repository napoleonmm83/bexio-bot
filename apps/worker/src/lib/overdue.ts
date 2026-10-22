// Mahnwesen Stufe 1 (2026-10-22): report overdue invoices in the daily Discord
// report. Read-only — the bot contacts no customer and creates nothing in bexio.

import type { BexioInvoice } from '@bexio-bot/bexio-client';
import { getZurichParts } from './billing-period.ts';

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' of `now` in Europe/Zurich. */
export function zurichToday(now: Date): string {
  const p = getZurichParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Customer name = first line of bexio's frozen contact_address (no extra API call). */
function customerOf(inv: BexioInvoice): string {
  const first = inv.contact_address?.split(/\r?\n/)[0]?.trim();
  return first || `Kontakt #${inv.contact_id}`;
}

function chf(amount: string | undefined): string {
  const n = Number(amount ?? '0');
  return `CHF ${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * One line per invoice whose due date (is_valid_to) lies before `today`
 * ('YYYY-MM-DD', Zurich), most overdue first. Due today is NOT overdue.
 * Amount is what is still open (total_remaining_payments), falling back to total.
 */
export function formatOverdue(invoices: BexioInvoice[], today: string): string[] {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return invoices
    .map((inv) => ({
      inv,
      days: Math.round((todayMs - Date.parse(`${inv.is_valid_to.slice(0, 10)}T00:00:00Z`)) / DAY_MS),
    }))
    .filter((x) => x.days > 0)
    .sort((a, b) => b.days - a.days)
    .map(({ inv, days }) =>
      `${inv.document_nr} · ${customerOf(inv)} · ${chf(inv.total_remaining_payments ?? inv.total)} · ${days} ${days === 1 ? 'Tag' : 'Tage'} überfällig`,
    );
}
