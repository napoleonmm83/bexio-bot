// Compute the next billing date for a recurring order, given bexio's repetition config.
// Algorithm: start from `start`, iterate forward in `interval × type`-units until we
// land on a date strictly after `today`. Return that date.
//
// All math runs in Europe/Zurich. Daylight Saving doesn't affect day-level dates;
// we work with year/month/day components, never absolute UTC offsets.

import type { BexioOrderRepetition } from '@bexio-bot/bexio-client';

const TZ = 'Europe/Zurich';

type Parts = { y: number; m: number; d: number };

function getZurichParts(input: Date | string): Parts {
  const d = typeof input === 'string' ? new Date(input) : input;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  return {
    y: Number(parts.find((p) => p.type === 'year')?.value),
    m: Number(parts.find((p) => p.type === 'month')?.value),
    d: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

/** Build a UTC Date that, when formatted in Europe/Zurich, lands on the given y/m/d at 09:00 local. */
function zurichDayToUtcDate({ y, m, d }: Parts): Date {
  // 09:00 local time is comfortably away from DST boundaries.
  // Use ISO with explicit Zurich-equivalent UTC offset (+01 winter / +02 summer).
  // Compute offset by trial: build a UTC date at 09:00, format to TZ, adjust.
  const guess = new Date(Date.UTC(y, m - 1, d, 8, 0, 0)); // 08:00 UTC == 09:00 winter / 10:00 summer
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const formatted = fmt.formatToParts(guess);
  const fy = Number(formatted.find((p) => p.type === 'year')?.value);
  const fm = Number(formatted.find((p) => p.type === 'month')?.value);
  const fd = Number(formatted.find((p) => p.type === 'day')?.value);
  // If the guess landed on the wrong day in TZ (rare DST edge), nudge by ±1h.
  if (fy === y && fm === m && fd === d) return guess;
  return new Date(Date.UTC(y, m - 1, d, 9, 0, 0));
}

function lastDayOfMonth(y: number, m: number): number {
  // m is 1-based; new Date(y, m, 0) returns the last day of month m
  return new Date(y, m, 0).getDate();
}

function addInterval(parts: Parts, type: string, interval: number): Parts {
  if (type === 'yearly') return { ...parts, y: parts.y + interval };
  if (type === 'quarterly') return addMonths(parts, 3 * interval);
  if (type === 'half_year') return addMonths(parts, 6 * interval);
  if (type === 'monthly') return addMonths(parts, interval);
  // Unknown type — bump by one month as a safe default
  return addMonths(parts, 1);
}

function addMonths(parts: Parts, months: number): Parts {
  let y = parts.y;
  let m = parts.m + months;
  while (m > 12) { y += 1; m -= 12; }
  while (m < 1) { y -= 1; m += 12; }
  // Cap day to the new month's length (e.g. Jan 31 + 1 month = Feb 28/29)
  const d = Math.min(parts.d, lastDayOfMonth(y, m));
  return { y, m, d };
}

function applySchedule(parts: Parts, schedule: string | undefined): Parts {
  if (schedule === 'last_day') {
    return { ...parts, d: lastDayOfMonth(parts.y, parts.m) };
  }
  return parts;
}

function isAfter(a: Parts, b: Parts): boolean {
  if (a.y !== b.y) return a.y > b.y;
  if (a.m !== b.m) return a.m > b.m;
  return a.d > b.d;
}

/**
 * Compute the next billing date for a recurring order.
 * Returns null if the repetition config is missing or unparseable.
 */
export function computeNextBilling(
  rep: BexioOrderRepetition | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!rep?.start || !rep.repetition) return null;

  const { type, interval, schedule } = rep.repetition;
  if (!type || interval < 1) return null;

  const today = getZurichParts(now);
  let candidate = applySchedule(getZurichParts(rep.start), schedule);

  // Walk forward until candidate is strictly after today
  let safetyBudget = 600; // 50 years of monthly intervals — defensive cap
  while (!isAfter(candidate, today) && safetyBudget-- > 0) {
    candidate = applySchedule(addInterval(candidate, type, interval), schedule);
  }
  if (safetyBudget <= 0) return null;

  return zurichDayToUtcDate(candidate);
}
