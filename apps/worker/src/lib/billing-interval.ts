// Add one billing interval to a date. Used by processSubscriptions to advance
// next_billing_date after a successful billing run.
//
// Behavior on month-end / leap-day edges: cap to the new month's last day
// (Jan 31 + monthly = Feb 28/29; Feb 29 + yearly = Feb 28).

export type SubscriptionInterval = 'monthly' | 'yearly';

function lastDayOfMonth(y: number, m: number): number {
  // m is 1-based
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addBillingInterval(date: Date, interval: SubscriptionInterval): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  const d = date.getUTCDate();

  let newY = y;
  let newM = m;
  if (interval === 'monthly') {
    newM = m + 1;
    if (newM > 11) {
      newM = 0;
      newY = y + 1;
    }
  } else {
    newY = y + 1;
  }

  const cappedDay = Math.min(d, lastDayOfMonth(newY, newM + 1));
  return new Date(Date.UTC(newY, newM, cappedDay));
}
