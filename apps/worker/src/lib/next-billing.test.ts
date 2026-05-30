import { expect, test, describe } from 'bun:test';
import { computeNextBilling, computeCurrentOccurrence, isOrderDue } from './next-billing.ts';
import type { BexioOrderRepetition } from '@bexio-bot/bexio-client';

// Helper: build a repetition config. `now` is always passed explicitly to the
// functions under test so these are deterministic (no Date.now() dependence).
function rep(
  start: string,
  type: string,
  interval = 1,
  extra: Partial<{ end: string | null; schedule: string; weekdays: string[] }> = {},
): BexioOrderRepetition {
  return {
    start,
    end: extra.end ?? null,
    repetition: {
      type,
      interval,
      ...(extra.schedule ? { schedule: extra.schedule } : {}),
      ...(extra.weekdays ? { weekdays: extra.weekdays } : {}),
    },
  };
}

// Use noon UTC so DST never shifts the Zurich calendar day in these assertions.
function at(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function ymd(d: Date | null): string | null {
  if (!d) return null;
  // Format in Zurich to compare the calendar day the function intends.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

describe('computeCurrentOccurrence — the latest scheduled occurrence on/before today', () => {
  // ── The exact incident: future-start orders must NOT be due ──────────────
  test('yearly with future start (Main Coon, due 2026-07-01) on 2026-05-30 → null', () => {
    expect(computeCurrentOccurrence(rep('2026-07-01', 'yearly'), at('2026-05-30'))).toBeNull();
  });

  test('yearly with far-future start (2027-05-01) on 2026-05-30 → null', () => {
    expect(computeCurrentOccurrence(rep('2027-05-01', 'yearly'), at('2026-05-30'))).toBeNull();
  });

  test('monthly with first occurrence tomorrow (#5, 2026-05-31) on 2026-05-30 → null', () => {
    expect(computeCurrentOccurrence(rep('2026-05-31', 'monthly'), at('2026-05-30'))).toBeNull();
  });

  // ── Due cases ────────────────────────────────────────────────────────────
  test('daily order is due every day → returns today', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-05-01', 'daily'), at('2026-05-30')))).toBe('2026-05-30');
  });

  test('daily order whose start is in the future → null', () => {
    expect(computeCurrentOccurrence(rep('2026-06-01', 'daily'), at('2026-05-30'))).toBeNull();
  });

  test('monthly due on the 15th, today is the 15th → 2026-05-15', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-05-15', 'monthly'), at('2026-05-15')))).toBe('2026-05-15');
  });

  test('monthly active since January, today 2026-05-20 → latest occurrence 2026-05-15', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-01-15', 'monthly'), at('2026-05-20')))).toBe('2026-05-15');
  });

  test('monthly active since January, today 2026-05-10 (before this month occ) → 2026-04-15', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-01-15', 'monthly'), at('2026-05-10')))).toBe('2026-04-15');
  });

  test('yearly active since 2024-07-01, today 2026-07-15 → 2026-07-01', () => {
    expect(ymd(computeCurrentOccurrence(rep('2024-07-01', 'yearly'), at('2026-07-15')))).toBe('2026-07-01');
  });

  test('yearly active since 2025-07-01, today 2026-05-30 (before this year occ) → 2025-07-01', () => {
    expect(ymd(computeCurrentOccurrence(rep('2025-07-01', 'yearly'), at('2026-05-30')))).toBe('2025-07-01');
  });

  // ── Schedule = last_day ──────────────────────────────────────────────────
  test('monthly last_day, start 2026-05-01, today 2026-05-15 → null (occurrence is 31st)', () => {
    expect(computeCurrentOccurrence(rep('2026-05-01', 'monthly', 1, { schedule: 'last_day' }), at('2026-05-15'))).toBeNull();
  });

  test('monthly last_day, start 2026-04-01, today 2026-05-15 → 2026-04-30', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-04-01', 'monthly', 1, { schedule: 'last_day' }), at('2026-05-15')))).toBe('2026-04-30');
  });

  // ── Weekly ────────────────────────────────────────────────────────────────
  test('weekly on Mondays, start 2026-05-01, today Sat 2026-05-30 → last Monday 2026-05-25', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-05-01', 'weekly', 1, { weekdays: ['monday'] }), at('2026-05-30')))).toBe('2026-05-25');
  });

  test('weekly with future start → null', () => {
    expect(computeCurrentOccurrence(rep('2026-06-08', 'weekly', 1, { weekdays: ['monday'] }), at('2026-05-30'))).toBeNull();
  });

  // ── End date clamping ──────────────────────────────────────────────────────
  test('monthly that ended 2026-03-31, today 2026-05-20 → last occurrence before end 2026-03-15', () => {
    expect(ymd(computeCurrentOccurrence(rep('2026-01-15', 'monthly', 1, { end: '2026-03-31' }), at('2026-05-20')))).toBe('2026-03-15');
  });

  // ── Defensive: missing / unparseable config ────────────────────────────────
  test('missing start → null', () => {
    expect(computeCurrentOccurrence({ repetition: { type: 'monthly', interval: 1 } } as BexioOrderRepetition, at('2026-05-30'))).toBeNull();
  });

  test('missing repetition → null', () => {
    expect(computeCurrentOccurrence({ start: '2026-01-01' } as BexioOrderRepetition, at('2026-05-30'))).toBeNull();
  });

  test('null/undefined rep → null', () => {
    expect(computeCurrentOccurrence(null, at('2026-05-30'))).toBeNull();
    expect(computeCurrentOccurrence(undefined, at('2026-05-30'))).toBeNull();
  });
});

describe('isOrderDue — due only on the occurrence day, within an N-day catch-up window', () => {
  // The exact incident: year-old orders must NOT bill today (no back-billing of
  // a past period). Live starts from bexio: #1=2021-07-01, #5=2021-03-31 last_day,
  // #6=2022-01-05, #7=2021-05-01.
  test('#1 yearly (start 2021-07-01) on 2026-05-30, window 3 → not due', () => {
    expect(isOrderDue(rep('2021-07-01', 'yearly'), at('2026-05-30'), 3)).toBeNull();
  });

  test('#5 monthly last_day (start 2021-03-31) on 2026-05-30, window 3 → not due (last occ was 04-30)', () => {
    expect(isOrderDue(rep('2021-03-31', 'monthly', 1, { schedule: 'last_day' }), at('2026-05-30'), 3)).toBeNull();
  });

  test('#5 monthly last_day on 2026-05-31 (its occurrence day) → DUE for period 2026-05', () => {
    expect(ymd(isOrderDue(rep('2021-03-31', 'monthly', 1, { schedule: 'last_day' }), at('2026-05-31'), 3))).toBe('2026-05-31');
  });

  test('#7 yearly (start 2021-05-01) on 2026-05-30, window 3 → not due (this year occ 05-01 was 29 days ago)', () => {
    expect(isOrderDue(rep('2021-05-01', 'yearly'), at('2026-05-30'), 3)).toBeNull();
  });

  test('#7 yearly on its occurrence day 2026-05-01 → DUE', () => {
    expect(ymd(isOrderDue(rep('2021-05-01', 'yearly'), at('2026-05-01'), 3))).toBe('2026-05-01');
  });

  test('daily order is due every day (window irrelevant)', () => {
    expect(ymd(isOrderDue(rep('2026-05-10', 'daily'), at('2026-05-30'), 3))).toBe('2026-05-30');
  });

  test('catch-up: occurrence 3 days ago is still due with window 3', () => {
    expect(ymd(isOrderDue(rep('2026-07-01', 'yearly'), at('2026-07-04'), 3))).toBe('2026-07-01');
  });

  test('occurrence 4 days ago is NOT due with window 3', () => {
    expect(isOrderDue(rep('2026-07-01', 'yearly'), at('2026-07-05'), 3)).toBeNull();
  });

  test('window 0 means only the exact occurrence day', () => {
    expect(ymd(isOrderDue(rep('2026-07-01', 'yearly'), at('2026-07-01'), 0))).toBe('2026-07-01');
    expect(isOrderDue(rep('2026-07-01', 'yearly'), at('2026-07-02'), 0)).toBeNull();
  });

  test('future start → not due', () => {
    expect(isOrderDue(rep('2026-08-01', 'monthly'), at('2026-05-30'), 3)).toBeNull();
  });
});

describe('computeNextBilling — unchanged: always a strictly-future occurrence', () => {
  test('yearly start 2026-07-01 on 2026-05-30 → 2026-07-01', () => {
    expect(ymd(computeNextBilling(rep('2026-07-01', 'yearly'), at('2026-05-30')))).toBe('2026-07-01');
  });

  test('monthly start 2026-01-15 on 2026-05-20 → next is 2026-06-15', () => {
    expect(ymd(computeNextBilling(rep('2026-01-15', 'monthly'), at('2026-05-20')))).toBe('2026-06-15');
  });
});
