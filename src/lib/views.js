// View-model for the UI: turns the flat item list into the sections the popup
// (and later the full-page app) shows, plus small formatting helpers. Pure, no DOM.

import { addDays, diffDays, parseDateStr, toDateStr } from './dates.js';
import { isDoneOn } from './model.js';
import { occurrencesBetween } from './recurrence.js';
import { isOverdue } from './reminders.js';

export const UPCOMING_DAYS = 7;
export const MAX_LATER = 50;
export const MAX_COMPLETED = 20;

const byTime = (a, b) =>
  (a.item.time ?? '').localeCompare(b.item.time ?? '') // all-day first
  || a.item.title.localeCompare(b.item.title)
  || a.item.createdAt - b.item.createdAt;

const doneLast = (a, b) => Number(a.done) - Number(b.done) || byTime(a, b);

const byDateThenTime = (a, b) => a.date.localeCompare(b.date) || byTime(a, b);

/**
 * A row is one thing to show: an item, one occurrence of a recurring item, or one day
 * of a multi-day item (`span` says which day: { index, total }, 1-based).
 * @typedef {{item:object, date:string|null, done:boolean, overdue:boolean,
 *            span:{index:number,total:number}|null}} Row
 */

const row = (item, date, done, overdue = false, span = null) => ({ item, date, done, overdue, span });

/**
 * @param {object[]} items
 * @param {Date} now
 * @param {{showDone?: boolean, category?: 'all'|'none'|string}} [opts]
 *   category: 'all' (default), 'none' (unsectioned only), or a section id.
 * @returns {{
 *  today: {overdue: Row[], rows: Row[], completed: Row[]},
 *  upcoming: {groups: {date:string, rows: Row[]}[], later: Row[]},
 *  general: Row[],
 *  counts: {today:number, upcoming:number, general:number}
 * }}
 */
export function buildViews(items, now, { showDone = false, category = 'all' } = {}) {
  const today = toDateStr(now);
  const horizon = addDays(today, UPCOMING_DAYS);

  if (category === 'none') items = items.filter((it) => !it.categoryId);
  else if (category !== 'all') items = items.filter((it) => it.categoryId === category);

  const overdue = [];
  const todayRows = [];
  const completed = [];
  const general = [];
  const later = [];
  const byDate = new Map();

  const addUpcoming = (r) => {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  };

  for (const item of items) {
    if (!item.date) {
      if (item.done && !showDone) continue;
      general.push(row(item, null, item.done));
      continue;
    }

    if (item.recurrence) {
      for (const date of occurrencesBetween(item, today, horizon)) {
        const done = isDoneOn(item, date);
        if (done && !showDone) continue;
        if (date === today) todayRows.push(row(item, date, done));
        else addUpcoming(row(item, date, done));
      }
      continue;
    }

    // One-off item, possibly spanning several days.
    const last = item.endDate ?? item.date;
    if (item.done && !showDone) continue;

    if (!item.done && isOverdue(item, now)) {
      overdue.push(row(item, last, false, true)); // dated by when it was due (its last day)
    } else if (last < today) {
      completed.push(row(item, item.date, true)); // only done items get here
    } else if (item.date > horizon) {
      later.push(row(item, item.date, item.done));
    } else {
      // Show it on every day of the span that falls between today and the horizon.
      const total = item.endDate ? diffDays(item.date, item.endDate) + 1 : 0;
      const from = item.date > today ? item.date : today;
      const to = last < horizon ? last : horizon;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const span = total ? { index: diffDays(item.date, d) + 1, total } : null;
        const r = row(item, d, item.done, false, span);
        if (d === today) todayRows.push(r);
        else addUpcoming(r);
      }
    }
  }

  overdue.sort(byDateThenTime);
  todayRows.sort(doneLast);
  completed.sort((a, b) => (b.item.doneAt ?? 0) - (a.item.doneAt ?? 0));
  general.sort((a, b) => Number(a.done) - Number(b.done) || a.item.createdAt - b.item.createdAt);
  later.sort(byDateThenTime);

  const groups = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({ date, rows: rows.sort(doneLast) }));

  const open = (rows) => rows.filter((r) => !r.done).length;
  // Upcoming counts things, not days: a daily habit or a 5-day trip counts once.
  const upcomingItems = new Set();
  for (const g of groups) for (const r of g.rows) if (!r.done) upcomingItems.add(r.item.id);
  for (const r of later) if (!r.done) upcomingItems.add(r.item.id);

  return {
    today: { overdue, rows: todayRows, completed: completed.slice(0, MAX_COMPLETED) },
    upcoming: { groups, later: later.slice(0, MAX_LATER) },
    general,
    counts: {
      today: overdue.length + open(todayRows),
      upcoming: upcomingItems.size,
      general: open(general),
    },
  };
}

/** The section an item is filed under, or null (also when the section no longer exists). */
export function categoryOf(item, categories) {
  return (item.categoryId && categories.find((c) => c.id === item.categoryId)) || null;
}

// ---------- labels ----------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Always an absolute label: "Wed 7 Oct" (with the year when it is not `today`'s year, if given). */
export function formatDate(dateStr, today) {
  const d = parseDateStr(dateStr);
  const year = !today || dateStr.slice(0, 4) === today.slice(0, 4) ? '' : ` ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** "Today", "Tomorrow", "Yesterday", or "Wed 7 Oct" (with the year when it is not this year). */
export function formatDay(dateStr, today) {
  if (dateStr === today) return 'Today';
  if (dateStr === addDays(today, 1)) return 'Tomorrow';
  if (dateStr === addDays(today, -1)) return 'Yesterday';
  return formatDate(dateStr, today);
}

export function formatWhen(item) {
  if (!item.time) return 'All day';
  if (!item.endTime) return item.time;
  return item.endDate ? `${item.time} \u2192 ${item.endTime}` : `${item.time}\u2013${item.endTime}`;
}

/** "Wed 7 \u2013 Thu 8 Oct" for a multi-day item, the plain date for a single-day one. */
export function formatRange(item, today) {
  if (!item.endDate) return formatDate(item.date, today);
  const a = parseDateStr(item.date);
  const b = parseDateStr(item.endDate);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    const year = !today || item.date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${b.getFullYear()}`;
    return `${WEEKDAYS[a.getDay()]} ${a.getDate()} \u2013 ${WEEKDAYS[b.getDay()]} ${b.getDate()} ${MONTHS[b.getMonth()]}${year}`;
  }
  return `${formatDate(item.date, today)} \u2013 ${formatDate(item.endDate, today)}`;
}

export const spanLabel = (span) => (span ? `Day ${span.index} of ${span.total}` : '');

export function repeatLabel(rule) {
  if (!rule) return '';
  const n = rule.interval;
  if (rule.freq === 'hourly') return n === 1 ? 'Every hour' : `Every ${n} hours`;
  if (rule.freq === 'daily') return n === 1 ? 'Daily' : `Every ${n} days`;
  if (rule.freq === 'monthly') return n === 1 ? 'Monthly' : `Every ${n} months`;
  const days = rule.weekdays ?? [];
  if (days.join() === '1,2,3,4,5' && n === 1) return 'Weekdays';
  const names = days.map((d) => WEEKDAYS[d]).join(', ');
  if (n === 1) return names ? `Weekly on ${names}` : 'Weekly';
  return names ? `Every ${n} weeks on ${names}` : `Every ${n} weeks`;
}

export function offsetLabel(min) {
  if (min === 0) return 'At start';
  if (min % 1440 === 0) return min === 1440 ? '1 day before' : `${min / 1440} days before`;
  if (min % 60 === 0) return min === 60 ? '1 hour before' : `${min / 60} hours before`;
  return `${min} min before`;
}

export function remindersSummary(item) {
  return item.reminders.map((r) => offsetLabel(r.offsetMin)).join(', ');
}

/** Options for the "default reminder" picker. `value` is minutes, or null for none. */
export const REMINDER_CHOICES = Object.freeze([
  { value: null, label: 'No reminder' },
  { value: 0, label: 'At start' },
  { value: 10, label: '10 min before' },
  { value: 30, label: '30 min before' },
  { value: 60, label: '1 hour before' },
  { value: 1440, label: '1 day before' },
]);

/**
 * Reminders for a newly created item. Undated items get none (nothing to count from).
 * All-day items always remind at the all-day time, because "10 min before 09:00"
 * is not what anyone wants for an all-day entry.
 */
export function remindersFor({ date, time }, defaultMin) {
  if (!date || defaultMin == null) return [];
  return [{ offsetMin: time ? defaultMin : 0 }];
}
