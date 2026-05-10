// Format a bexio invoice's `is_valid_from` date as a billing_period string.
// Format must round-trip: same date in same TZ → same period string.
//
// We use a coarse 'YYYY-MM' for monthly/semi-annual/quarterly/yearly. Reason: bexio
// is the source-of-truth for "next due date" — we only need a stable key to detect
// duplicate creation. (order_id, 'YYYY-MM') is unique per billing month, which is
// the practical granularity Marcus' invoices live at.

const ZURICH_TZ = 'Europe/Zurich';

export function formatBillingPeriod(isoDate: string): string {
  // bexio gives '2026-05-10' or '2026-05-10 00:00:00' style dates
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date from bexio: ${isoDate}`);
  }

  // Use Intl.DateTimeFormat to get the year/month in Europe/Zurich
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZURICH_TZ,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) {
    throw new Error(`Could not format billing period from ${isoDate}`);
  }
  return `${year}-${month}`;
}
