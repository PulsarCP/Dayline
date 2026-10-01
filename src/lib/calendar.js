// Pure helpers for the full-page calendar: month grid, items per day, day selection,
// and the "All" list search/filter. No DOM, no chrome.* calls.

import { addDays, diffDays, isValidDateStr, toDateStr, weekdayOf } from './dates.js';
import { isDoneOn } from './model.js';
import { occurrencesBetween } from './recurrence.js';
import { isOverdue } from './reminders.js';

/** 6 weeks x 7 days of "YYYY-MM-DD" covering the month. `weekStart`: 1 = Monday, 0 = Sunday. */
export function monthGrid(year, month0, weekStart = 1) {
  const first = toDateStr(new Date(year, month0, 1));
  const lead = (weekdayOf(first) - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (__, d) => addDays(start, w * 7 + d)));
}

const timeKey = (r) => (r.item.time && !r.item.endDate ? r.item.time : '');
const byDayOrder = (a, b) => Number(a.done) - Number(b.done) || timeKey(a).localeCompare(timeKey(b))
  || a.item.title.localeCompare(b.item.title);

/**
 * Rows for every day in [from, to]: Map("YYYY-MM-DD" -> Row[]). A row is one item on one
 * day (one occurrence of a repeating item, one day of a multi-day item).
 * Row: { item, date, done, overdue, span: {index,total}|null }. Undated items never appear.
 */
export function dayRows(items, from, to, now = new Date()) {
  const map = new Map();
  const put = (date, row) => {
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(row);
  };
  for (const item of items) {
    if (!item.date) continue;
    if (item.recurrence) {
      for (const date of occurrencesBetween(item, from, to)) {
        put(date, { item, date, done: isDoneOn(item, date), overdue: false, span: null });
      }
      continue;
    }
    const last = item.endDate ?? item.date;
    const total = item.endDate ? diffDays(item.date, item.endDate) + 1 : 0;
    const overdue = isOverdue(item, now);
    const start = item.date > from ? item.date : from;
    const stop = last < to ? last : to;
    for (let d = start; d <= stop; d = addDays(d, 1)) {
      const span = total ? { index: diffDays(item.date, d) + 1, total } : null;
      put(d, { item, date: d, done: item.done, overdue: overdue && d === last, span });
    }
  }
  for (const rows of map.values()) rows.sort(byDayOrder);
  return map;
}

/**
 * Click on a day. Plain click selects only that day, Ctrl/Cmd toggles it, Shift selects
 * the range from the last clicked day. Returns { selected: sorted dates, anchor }.
 */
export function selectDay({ selected, anchor }, clicked, { ctrl = false, shift = false } = {}) {
  let set = new Set(selected);
  if (shift && anchor) {
    const [a, b] = anchor <= clicked ? [anchor, clicked] : [clicked, anchor];
    if (diffDays(a, b) <= 366) {
      if (!ctrl) set = new Set();
      for (let d = a; d <= b; d = addDays(d, 1)) set.add(d);
    }
    return { selected: [...set].sort(), anchor };
  }
  if (ctrl) {
    if (set.has(clicked)) set.delete(clicked);
    else set.add(clicked);
    return { selected: [...set].sort(), anchor: clicked };
  }
  if (set.size === 1 && set.has(clicked)) return { selected: [], anchor: null }; // click again to clear
  return { selected: [clicked], anchor: clicked };
}

/**
 * Where a new item goes when days are selected: the first selected day, and a last day
 * when the selection is one unbroken run of several days.
 */
export function selectionTarget(selected) {
  const days = [...new Set(selected.filter(isValidDateStr))].sort();
  if (!days.length) return { date: null, endDate: null };
  const first = days[0];
  const last = days[days.length - 1];
  const contiguous = days.length > 1 && diffDays(first, last) === days.length - 1;
  return { date: first, endDate: contiguous ? last : null };
}

export const STATUS_FILTERS = ['open', 'done', 'all'];
export const WHEN_FILTERS = ['any', 'overdue', 'today', 'week', 'dated', 'undated', 'repeating'];

const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Done for the "All" list: a repeating item is never "done" as a whole. */
const itemDone = (item) => (item.recurrence ? false : item.done);

/**
 * The "All" list: search + filters, sorted dated-first (soonest first), then undated.
 * @param {object[]} items
 * @param {{query?:string, status?:'open'|'done'|'all', category?:'all'|'none'|string,
 *          when?:string, from?:string, to?:string}} f
 */
export function filterAll(items, f = {}, now = new Date()) {
  const { query = '', status = 'open', category = 'all', when = 'any', from = '', to = '' } = f;
  const today = toDateStr(now);
  const weekEnd = addDays(today, 6);
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const out = items.filter((item) => {
    if (status === 'open' && itemDone(item)) return false;
    if (status === 'done' && !itemDone(item)) return false;
    if (category === 'none' ? item.categoryId : category !== 'all' && item.categoryId !== category) return false;
    if (words.length) {
      const hay = normalize(`${item.title} ${item.notes}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    const last = item.endDate ?? item.date;
    switch (when) {
      case 'overdue': if (!isOverdue(item, now)) return false; break;
      case 'today': if (!item.date || !occurrencesBetween(item, today, today).length
        && !(item.endDate && item.date <= today && item.endDate >= today)) return false; break;
      case 'week': if (!item.date || !(occurrencesBetween(item, today, weekEnd).length
        || (item.endDate && item.date <= weekEnd && item.endDate >= today))) return false; break;
      case 'dated': if (!item.date) return false; break;
      case 'undated': if (item.date) return false; break;
      case 'repeating': if (!item.recurrence) return false; break;
      default: break;
    }
    if ((from || to) && !rangeTouches(item, last, from, to)) return false;
    return true;
  });
  const key = (it) => it.date ?? '9999-99-99';
  return out.sort((a, b) => key(a).localeCompare(key(b))
    || (a.time ?? '').localeCompare(b.time ?? '') || a.createdAt - b.createdAt);
}

function rangeTouches(item, last, from, to) {
  if (!item.date) return false;
  const lo = from && isValidDateStr(from) ? from : '0000-01-01';
  const hi = to && isValidDateStr(to) ? to : '9999-12-31';
  if (item.recurrence) return occurrencesBetween(item, lo < item.date ? item.date : lo, hi > '9000' ? addDays(lo < item.date ? item.date : lo, 800) : hi).length > 0;
  return item.date <= hi && last >= lo;
}

export const monthTitle = (year, month0) =>
  new Date(year, month0, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
