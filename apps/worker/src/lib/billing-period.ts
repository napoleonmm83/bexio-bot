// Format a bexio invoice's `is_valid_from` date as a billing_period string.
// Format must round-trip: same date + repetition-type in same TZ → same period string.
//
// Granularity is chosen per repetition type so the (order_id, billing_period)
// duplicate-guard in invoice_runs has the right resolution:
//   daily   → 'YYYY-MM-DD'  (one row per day)
//   weekly  → 'YYYY-Www'    (ISO week, one row per week)
//   monthly → 'YYYY-MM'     (one row per month — also default for quarterly/half/yearly,
//                            since those still ship at most one invoice per calendar month)
//
// Why per-type: a monthly-coarse 'YYYY-MM' key blocks every subsequent day of the same
// month for daily-recurring orders (see incident on 2026-05-22 — the daily canary
// AU-00013 was wedged after the first successful invoice for 2026-05).

const ZURICH_TZ = 'Europe/Zurich';

/** Raw bexio repetition.type (e.g. 'daily', 'weekly', 'monthly', 'yearly'). */
export type BexioRepetitionType = string | undefined;

export function formatBillingPeriod(isoDate: string, repetitionType?: BexioRepetitionType): string {
  // bexio gives '2026-05-10' or '2026-05-10 00:00:00' style dates
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date from bexio: ${isoDate}`);
  }

  const parts = getZurichParts(d);

  if (repetitionType === 'daily') {
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  if (repetitionType === 'weekly') {
    const { isoYear, isoWeek } = isoWeekParts(parts);
    return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
  }
  // monthly / yearly / quarterly / half_year / undefined → month-coarse
  return `${parts.year}-${parts.month}`;
}

function getZurichParts(d: Date): { year: string; month: string; day: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZURICH_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error(`Could not format billing period from ${d.toISOString()}`);
  }
  return { year, month, day };
}

// ISO 8601 week date: week starts Monday, week 1 contains the year's first Thursday.
// We compute against the Zurich-local calendar day (DST doesn't affect day-of-year).
function isoWeekParts(parts: { year: string; month: string; day: string }): {
  isoYear: number;
  isoWeek: number;
} {
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  // Build a UTC date for the same calendar day; then apply the standard ISO-week algorithm.
  const date = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of the current ISO week (per the algorithm)
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}
