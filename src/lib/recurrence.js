// Recurrence rules and occurrence expansion.
//
// Rule shape: { freq: 'daily'|'weekly'|'monthly', interval: n,
//               weekdays?: [0..6] (weekly only, 0 = Sunday), until?: 'YYYY-MM-DD' }
// The series starts on the item's own `date`.

import {
  addDays, daysInMonth, diffDays, isValidDateStr, parseDateStr, toDateStr, weekdayOf,
} from './dates.js';

export const FREQS = ['daily', 'weekly', 'monthly'];
export const MAX_SPAN_DAYS = 800; // hard cap on any expansion window
const MAX_INTERVAL = { daily: 365, weekly: 52, monthly: 24 };

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
  if (r.freq === 'daily') {
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

/** First occurrence strictly after `after` (or on it with includeAfter), or null. */
export function nextOccurrence(item, after, { includeAfter = false } = {}) {
  const from = includeAfter ? after : addDays(after, 1);
  return occurrencesBetween(item, from, addDays(from, MAX_SPAN_DAYS))[0] ?? null;
}
