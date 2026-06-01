// Compute the next billing date for a recurring order, given bexio's repetition config.
// Algorithm: start from `start`, iterate forward in `interval × type`-units until we
// land on a date strictly after `today`. Return that date.
//
// All math runs in Europe/Zurich. Daylight Saving doesn't affect day-level dates;
// we work with year/month/day components, never absolute UTC offsets.

import type { BexioOrderRepetition } from '@bexio-bot/bexio-client';

const WEEKDAY_INDEX: Record<string, number> = {
  // bexio uses lowercase English names. JS Date.getDay() returns 0=Sunday..6=Saturday.
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const TZ = 'Europe/Zurich';

// Safety cap on the day/interval walk. It bounds distance from START, so set it
// high enough (~54y of daily/weekly steps) to cover any realistic start date
// without ever running unbounded. The walk is plain integer arithmetic — even
// the worst case (20k iterations) is microseconds.
const MAX_STEPS = 20_000;

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

function addInterval(parts: Parts, type: string, interval: number, anchorDay: number): Parts {
  if (type === 'yearly') {
    const y = parts.y + interval;
    return { y, m: parts.m, d: Math.min(anchorDay, lastDayOfMonth(y, parts.m)) };
  }
  if (type === 'quarterly') return addMonths(parts, 3 * interval, anchorDay);
  if (type === 'half_year') return addMonths(parts, 6 * interval, anchorDay);
  if (type === 'monthly') return addMonths(parts, interval, anchorDay);
  if (type === 'daily') return addDays(parts, interval);
  // weekly handled separately (needs weekdays). Unknown type → one month.
  return addMonths(parts, 1, anchorDay);
}

function addDays(parts: Parts, days: number): Parts {
  const d = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// Add whole months and set the day from the ORIGINAL anchor (capped to the new
// month), NOT from the carried day. Carrying a previously-capped day would clamp
// a 31st anchor to the 28th forever after February; re-anchoring lets it re-climb
// to 03-31, 04-30, etc.
function addMonths(parts: Parts, months: number, anchorDay: number): Parts {
  let y = parts.y;
  let m = parts.m + months;
  while (m > 12) { y += 1; m -= 12; }
  while (m < 1) { y -= 1; m += 12; }
  return { y, m, d: Math.min(anchorDay, lastDayOfMonth(y, m)) };
}

function applySchedule(parts: Parts, schedule: string | undefined): Parts {
  if (schedule === 'last_day') {
    return { ...parts, d: lastDayOfMonth(parts.y, parts.m) };
  }
  // 'fixed_day' (and undefined): keep the anchor day-of-month. addInterval
  // re-anchors to the original start day each step (capped to the month), so a
  // 31st anchor gives 03-31 / 04-30 rather than clamping to the 28th.
  return parts;
}

function isAfter(a: Parts, b: Parts): boolean {
  if (a.y !== b.y) return a.y > b.y;
  if (a.m !== b.m) return a.m > b.m;
  return a.d > b.d;
}

/** UTC-midnight ms of the Monday of the ISO week containing the given day. */
function mondayMidnightUtc(p: Parts): number {
  const utc = Date.UTC(p.y, p.m - 1, p.d);
  const dow = new Date(utc).getUTCDay(); // 0=Sun..6=Sat
  return utc - ((dow + 6) % 7) * 86_400_000;
}

/** Whole ISO weeks (Monday-aligned) between two calendar days. Used to honor a
 *  weekly `interval` > 1 — e.g. interval=2 bills only every other week. */
function weeksBetween(start: Parts, day: Parts): number {
  return Math.round((mondayMidnightUtc(day) - mondayMidnightUtc(start)) / (7 * 86_400_000));
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

  const r = rep.repetition;
  const { type, interval, schedule } = r;
  if (!type || interval < 1) return null;

  const today = getZurichParts(now);

  // Weekly is special: rather than walking by N weeks, we walk day-by-day and
  // pick the next date that lands on one of the configured weekdays.
  if (type === 'weekly') {
    const weekdays = (r.weekdays as string[] | undefined) ?? [];
    if (weekdays.length === 0) return null;
    const targetDays = new Set(
      weekdays.map((w) => WEEKDAY_INDEX[w.toLowerCase()]).filter((n): n is number => n !== undefined),
    );
    if (targetDays.size === 0) return null;

    const startParts = getZurichParts(rep.start);
    let cursor = startParts;
    // Walk forward day-by-day. Cap at 3650 days (10y) so an old start with a
    // large interval still resolves. An occurrence counts only on a configured
    // weekday AND in an active week (every `interval`-th week from the start).
    for (let i = 0; i < MAX_STEPS; i++) {
      const dow = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d)).getUTCDay();
      if (
        isAfter(cursor, today) &&
        targetDays.has(dow) &&
        weeksBetween(startParts, cursor) % interval === 0
      ) {
        return zurichDayToUtcDate(cursor);
      }
      cursor = addDays(cursor, 1);
    }
    return null;
  }

  // daily / monthly / quarterly / half_year / yearly all use interval-stepping
  const anchorDay = getZurichParts(rep.start).d;
  let candidate = applySchedule(getZurichParts(rep.start), schedule);
  let safetyBudget = MAX_STEPS;
  while (!isAfter(candidate, today) && safetyBudget-- > 0) {
    candidate = applySchedule(addInterval(candidate, type, interval, anchorDay), schedule);
  }
  if (safetyBudget <= 0) return null;

  return zurichDayToUtcDate(candidate);
}

/**
 * Compute the CURRENT due occurrence: the latest scheduled occurrence on or
 * before `now`. This is the f(missing) due-gate for the order pipeline.
 *
 *   - null  → not due: the schedule hasn't started yet (start in the future),
 *             the recurrence ended before today, or the config is unparseable.
 *   - Date  → the order is due for that occurrence's billing period. The
 *             state machine derives the billing_period key from this date, so
 *             the (order_id, billing_period) dedup is anchored to the real
 *             schedule (one invoice per occurrence) instead of to the run day.
 *
 * Counterpart to computeNextBilling: that one always points at the next FUTURE
 * occurrence (good for the dashboard), this one points at the most recent due
 * occurrence (good for "should we bill right now?"). bexio's
 * POST /kb_order/{id}/invoice is NOT a recurrence trigger — it bills on demand
 * — so the bot has to decide due-ness itself, here.
 *
 * On a missed run, this catches up at most ONE occurrence (the latest); it
 * never bills a backlog of skipped periods.
 */
export function computeCurrentOccurrence(
  rep: BexioOrderRepetition | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!rep?.start || !rep.repetition) return null;

  const r = rep.repetition;
  const { type, interval, schedule } = r;
  if (!type || interval < 1) return null;

  const today = getZurichParts(now);
  const end = rep.end ? getZurichParts(rep.end) : null;
  // If the recurrence ended before today, the latest billable occurrence is
  // capped at `end` rather than `today`.
  const horizon = end && isAfter(today, end) ? end : today;

  // Weekly: walk day-by-day, remembering the last weekday-match within horizon.
  if (type === 'weekly') {
    const weekdays = (r.weekdays as string[] | undefined) ?? [];
    if (weekdays.length === 0) return null;
    const targetDays = new Set(
      weekdays.map((w) => WEEKDAY_INDEX[w.toLowerCase()]).filter((n): n is number => n !== undefined),
    );
    if (targetDays.size === 0) return null;

    const startParts = getZurichParts(rep.start);
    let cursor = startParts;
    let last: Parts | null = null;
    for (let i = 0; i < MAX_STEPS; i++) {
      if (isAfter(cursor, horizon)) break;
      const dow = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d)).getUTCDay();
      // Active week only (honors interval > 1, e.g. bi-weekly).
      if (targetDays.has(dow) && weeksBetween(startParts, cursor) % interval === 0) {
        last = cursor;
      }
      cursor = addDays(cursor, 1);
    }
    return last ? zurichDayToUtcDate(last) : null;
  }

  // daily / monthly / quarterly / half_year / yearly: interval-stepping.
  const anchorDay = getZurichParts(rep.start).d;
  let candidate = applySchedule(getZurichParts(rep.start), schedule);
  let last: Parts | null = null;
  let safetyBudget = MAX_STEPS;
  while (!isAfter(candidate, horizon) && safetyBudget-- > 0) {
    last = candidate;
    candidate = applySchedule(addInterval(candidate, type, interval, anchorDay), schedule);
  }
  if (safetyBudget <= 0) return null;

  return last ? zurichDayToUtcDate(last) : null;
}

/**
 * The order's due-gate: is the order due to be billed right now?
 *
 *   - Date → due; bill for this occurrence's billing period.
 *   - null → not due; skip.
 *
 * An order is due iff its most recent scheduled occurrence falls within the
 * last `windowDays` days (inclusive of today). windowDays=0 means "only on the
 * exact occurrence day". The window is a catch-up tolerance: if the daily run
 * is skipped (outage), the occurrence is still billed for up to `windowDays`
 * afterwards. It deliberately does NOT back-bill older periods — an order whose
 * last occurrence is weeks/years in the past (e.g. one freshly onboarded into
 * the bot) is NOT billed; it waits for its next scheduled occurrence. This
 * matches the "Nächste Fälligkeit" date shown in the dashboard.
 */
export function isOrderDue(
  rep: BexioOrderRepetition | null | undefined,
  now: Date = new Date(),
  windowDays = 0,
): Date | null {
  const occurrence = computeCurrentOccurrence(rep, now);
  if (!occurrence) return null;

  const occ = getZurichParts(occurrence);
  const today = getZurichParts(now);
  const occMidnightUtc = Date.UTC(occ.y, occ.m - 1, occ.d);
  const todayMidnightUtc = Date.UTC(today.y, today.m - 1, today.d);
  const diffDays = Math.round((todayMidnightUtc - occMidnightUtc) / 86_400_000);

  // diffDays is always >= 0 (occurrence is on/before today by construction).
  return diffDays <= windowDays ? occurrence : null;
}
