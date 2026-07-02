// Format a bexio invoice's `is_valid_from` date as a billing_period string.
// Format must round-trip: same date + repetition-type in same TZ → same period string.
//
// Granularity is chosen per repetition type so the (order_id, billing_period)
// duplicate-guard in invoice_runs has the right resolution:
//   daily   → 'YYYY-MM-DD'  (one row per day)
//   weekly  → 'YYYY-MM-DD'  (occurrence-anchored day — NOT ISO week. An ISO-week key
//                            collided for orders configured with 2+ weekdays: Mon and
//                            Thu of the same week deduped to one invoice. The key is
//                            anchored to the occurrence date, so a single-weekday order
//                            still gets exactly one row per occurrence. C1, 2026-07-02)
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

  // daily AND weekly use occurrence-anchored day granularity (see header — weekly
  // was ISO-week and collided for multi-weekday orders).
  if (repetitionType === 'daily' || repetitionType === 'weekly') {
    return `${parts.year}-${parts.month}-${parts.day}`;
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
