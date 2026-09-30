// View-model for the UI: turns the flat item list into the sections the popup
// (and later the full-page app) shows, plus small formatting helpers. Pure, no DOM.

import { addDays, parseDateStr, toDateStr } from './dates.js';
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
 * A row is one thing to show: an item, or one occurrence of a recurring item.
 * @typedef {{item:object, date:string|null, done:boolean, overdue:boolean}} Row
 */

/**
 * @returns {{
 *  today: {overdue: Row[], rows: Row[], completed: Row[]},
 *  upcoming: {groups: {date:string, rows: Row[]}[], later: Row[]},
 *  general: Row[],
 *  counts: {today:number, upcoming:number, general:number}
 * }}
 */
export function buildViews(items, now, { showDone = false } = {}) {
  const today = toDateStr(now);
  const horizon = addDays(today, UPCOMING_DAYS);

  const overdue = [];
  const todayRows = [];
  const completed = [];
  const general = [];
  const later = [];
  const byDate = new Map();

  const addUpcoming = (row) => {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  };

  for (const item of items) {
    if (!item.date) {
      if (item.done && !showDone) continue;
      general.push({ item, date: null, done: item.done, overdue: false });
      continue;
    }

    if (item.recurrence) {
      for (const date of occurrencesBetween(item, today, horizon)) {
        const done = isDoneOn(item, date);
        if (done && !showDone) continue;
        const row = { item, date, done, overdue: false };
        if (date === today) todayRows.push(row);
        else addUpcoming(row);
      }
      continue;
    }

    if (item.done) {
      if (!showDone) continue;
      const row = { item, date: item.date, done: true, overdue: false };
      if (item.date === today) todayRows.push(row);
      else if (item.date < today) completed.push(row);
      else if (item.date <= horizon) addUpcoming(row);
      else later.push(row);
      continue;
    }

    const late = isOverdue(item, now);
    const row = { item, date: item.date, done: false, overdue: late };
    if (late) overdue.push(row);
    else if (item.date <= today) todayRows.push(row);
    else if (item.date <= horizon) addUpcoming(row);
    else later.push(row);
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
  return {
    today: { overdue, rows: todayRows, completed: completed.slice(0, MAX_COMPLETED) },
    upcoming: { groups, later: later.slice(0, MAX_LATER) },
    general,
    counts: {
      today: overdue.length + open(todayRows),
      upcoming: groups.reduce((n, g) => n + open(g.rows), 0) + open(later),
      general: open(general),
    },
  };
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
  return item.endTime ? `${item.time}–${item.endTime}` : item.time;
}

export function repeatLabel(rule) {
  if (!rule) return '';
  const n = rule.interval;
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
