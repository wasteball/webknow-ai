import type { Freshness, TimeContext } from './agent-types';

const DAY_MS = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function calendarDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (!datePattern.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return date;
}

export function shiftCalendarDays(value: string, days: number): string {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function shiftCalendarMonths(value: string, months: number): string {
  const date = calendarDate(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

function localDateAt(formatter: Intl.DateTimeFormat, instant: number): string {
  const parts = formatter.formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Finds the first instant of a local date, including midnight DST transitions. */
function startOfLocalDate(value: string, formatter: Intl.DateTimeFormat): number {
  const nominal = calendarDate(value).getTime();
  let low = nominal - 2 * DAY_MS;
  let high = nominal + 2 * DAY_MS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(formatter, middle) < value) low = middle + 1;
    else high = middle;
  }
  if (localDateAt(formatter, low) !== value) throw new RangeError('Calendar date does not exist in this timezone');
  return low;
}

/** Ranges are inclusive UTC instants; date-only bounds mean entire local calendar days. */
export function buildTimeContext(now: Date, timeZone: string, freshness: Freshness,
  requestedRange?: { from: string; to: string }): TimeContext {
  const formatter = dateFormatter(timeZone); // Invalid browser timezone fails honestly.
  const localDate = localDateAt(formatter, now.getTime());
  const context: TimeContext = { nowIso: now.toISOString(), localDate, timeZone };
  let range = requestedRange;
  if (!range && freshness !== 'any' && freshness !== 'live') {
    const from = freshness === 'week' ? shiftCalendarDays(localDate, -6)
      : freshness === 'month' ? shiftCalendarMonths(localDate, -1) : localDate;
    range = { from, to: localDate };
  }
  if (!range) return context;
  const bound = (value: string, end: boolean) => {
    if (datePattern.test(value)) {
      return end ? startOfLocalDate(shiftCalendarDays(value, 1), formatter) - 1 : startOfLocalDate(value, formatter);
    }
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new RangeError('Range must include dates or timezone offsets');
    calendarDate(value.slice(0, 10));
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) throw new RangeError('Invalid time range');
    return instant;
  };
  const from = bound(range.from, false);
  const to = bound(range.to, true);
  if (from > to) throw new RangeError('Reversed time range');
  return { ...context, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
