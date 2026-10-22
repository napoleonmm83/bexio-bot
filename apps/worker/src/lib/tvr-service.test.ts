import { expect, test } from 'bun:test';
import { parseCompletionDate } from './tvr-service';

const today = { year: 2026, month: 11, day: 12 };

test('completion_date: valid, default today, and bounds (review #2)', () => {
  expect(parseCompletionDate('2026-11-03', today)).toEqual({ year: 2026, month: 11, day: 3 });
  expect(parseCompletionDate(undefined, today)).toEqual(today);
  expect(parseCompletionDate('2026-08-01', today)).toEqual({ year: 2026, month: 8, day: 1 }); // exactly 3 months back
  expect(() => parseCompletionDate('2026-07-31', today)).toThrow(/älter als 3 Monate/);
  expect(() => parseCompletionDate('2062-11-01', today)).toThrow(/Zukunft/);
  expect(() => parseCompletionDate('2026-11-13', today)).toThrow(/Zukunft/);
  expect(() => parseCompletionDate('2026-02-30', today)).toThrow(/not a real date/);
  expect(() => parseCompletionDate('3.11.2026', today)).toThrow(/YYYY-MM-DD/);
});
