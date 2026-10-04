// Recurrence rules and occurrence expansion.
//
// Rule shape: { freq: 'hourly'|'daily'|'weekly'|'monthly', interval: n,
//               weekdays?: [0..6] (weekly only, 0 = Sunday), until?: 'YYYY-MM-DD' }
// The series starts on the item's own `date`. An hourly rule repeats every `interval`
// hours (1..23) counted continuously from the item's start time; the occurrence is
// the day, and `slotsOn` lists the clock times inside it.

import {
  addDays, daysInMonth, diffDays, isValidDateStr, parseDateStr, toDateStr, weekdayOf,
} from './dates.js';

export const FREQS = ['hourly', 'daily', 'weekly', 'monthly'];
export const MAX_SPAN_DAYS = 800; // hard cap on any expansion window
const MAX_INTERVAL = { hourly: 23, daily: 365, weekly: 52, monthly: 24 };

/** Validates and cleans a rule. Returns null for "no recurrence"; throws on invalid input. */
export function normalizeRecurrence(r) {
  if (r == null) return null;
  if (typeof r !== 'object') throw new TypeError('recurrence must be an object');
  if (!FREQS.includes(r.freq)) throw new RangeError('invalid recurrence freq');
  const interval = r.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL[r.freq]) {
    throw new RangeError('invalid recurrence interval');
  }
  const out = { freq: r.freq, interval };
  if (r.freq === 'weekly' && r.weekdays != null) {
    if (!Array.isArray(r.weekdays)) throw new TypeError('weekdays must be an array');
    const days = [...new Set(r.weekdays)];
    if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new RangeError('invalid weekday');
    }
    if (days.length) out.weekdays = days.sort((a, b) => a - b);
  }
  if (r.until != null) {
    if (!isValidDateStr(r.until)) throw new RangeError('invalid recurrence until');
    out.until = r.until;
  }
  return out;
}

/**
 * Occurrence dates of `item` within [from, to] (inclusive, "YYYY-MM-DD").
 * Undated items have none. The window is capped at MAX_SPAN_DAYS.
 */
export function occurrencesBetween(item, from, to) {
  if (!item.date) return [];
  if (diffDays(from, to) < 0) return [];
  if (diffDays(from, to) > MAX_SPAN_DAYS) to = addDays(from, MAX_SPAN_DAYS);

  const r = item.recurrence;
  if (!r) return item.date >= from && item.date <= to ? [item.date] : [];

  const start = item.date;
  const last = r.until && r.until < to ? r.until : to;
  const first = start > from ? start : from;
  if (first > last) return [];

  const out = [];
  if (r.freq === 'hourly') {
    for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  } else if (r.freq === 'daily') {
    const k = Math.ceil(diffDays(start, first) / r.interval);
    for (let d = addDays(start, k * r.interval); d <= last; d = addDays(d, r.interval)) out.push(d);
  } else if (r.freq === 'weekly') {
    const days = r.weekdays?.length ? r.weekdays : [weekdayOf(start)];
    const weekAnchor = addDays(start, -weekdayOf(start)); // Sunday of the start week
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (!days.includes(weekdayOf(d))) continue;
      if (Math.floor(diffDays(weekAnchor, d) / 7) % r.interval === 0) out.push(d);
    }
  } else {
    const s = parseDateStr(start);
    const f = parseDateStr(first);
    const monthsToFirst = (f.getFullYear() - s.getFullYear()) * 12 + (f.getMonth() - s.getMonth());
    let k = Math.max(0, Math.ceil(monthsToFirst / r.interval));
    for (let guard = 0; guard < 1000; guard++, k++) {
      const idx = s.getMonth() + k * r.interval;
      const y = s.getFullYear() + Math.floor(idx / 12);
      const m = idx % 12;
      const d = toDateStr(new Date(y, m, Math.min(s.getDate(), daysInMonth(y, m))));
      if (d > last) break;
      if (d >= first) out.push(d);
    }
  }
  return out;
}

/**
 * Clock times ("HH:MM") at which an hourly item fires on `date`, counted continuously
 * from its first start (date + time) in steps of `interval` hours. Non-hourly items
 * have a single slot (their own time, or null for all-day).
 */
export function slotsOn(item, date) {
  const r = item.recurrence;
  if (r?.freq !== 'hourly' || !item.time) return [item.time ?? null];
  const [h, m] = item.time.split(':').map(Number);
  const step = r.interval * 60;
  const dayStart = diffDays(item.date, date) * 1440 - (h * 60 + m); // minutes since first slot
  const out = [];
  for (let k = Math.max(0, Math.ceil(dayStart / step)); ; k++) {
    const t = k * step - dayStart;
    if (t >= 1440) break;
    const mins = t;
    out.push(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
  }
  return out;
}

/** Key under which one occurrence is marked done: the date, or `date@HH:MM` for one slot of an hourly item. */
export const occurrenceKey = (item, date, slot = null) =>
  (item.recurrence?.freq === 'hourly' && slot ? `${date}@${slot}` : date);

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * What an hourly item shows today: the latest slot that is already due (open until ticked),
 * otherwise the next upcoming one. Returns null when it does not occur today.
 * { slot, done, next }  -- `next` is the slot after the one shown (or null).
 */
export function hourlyState(item, now) {
  if (item.recurrence?.freq !== 'hourly') return null;
  const today = toDateStr(now);
  if (!occurrencesBetween(item, today, today).length) return null;
  const slots = slotsOn(item, today);
  if (!slots.length) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isDone = (s) => (item.completedDates ?? []).includes(`${today}@${s}`);
  const due = slots.filter((s) => minutesOf(s) <= nowMin);
  const later = slots.filter((s) => minutesOf(s) > nowMin);
  if (due.length) {
    const slot = due[due.length - 1];
    return { slot, done: isDone(slot), next: later[0] ?? null };
  }
  return { slot: later[0], done: isDone(later[0]), next: later[1] ?? null };
}

/** First occurrence strictly after `after` (or on it with includeAfter), or null. */
export function nextOccurrence(item, after, { includeAfter = false } = {}) {
  const from = includeAfter ? after : addDays(after, 1);
  return occurrencesBetween(item, from, addDays(from, MAX_SPAN_DAYS))[0] ?? null;
}
