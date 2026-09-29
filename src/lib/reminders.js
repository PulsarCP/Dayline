// Reminder scheduling maths. Pure functions: no chrome.* calls, so it is testable
// in Node. The background worker (phase 3) turns these results into chrome.alarms.

import { addDays, combine, toDateStr } from './dates.js';
import { DEFAULT_SETTINGS, isDoneOn } from './model.js';
import { occurrencesBetween } from './recurrence.js';

/** Start moment of an occurrence. All-day items count as `allDayTime` (default 09:00). */
export function occurrenceStart(item, date, allDayTime = DEFAULT_SETTINGS.allDayReminderTime) {
  return combine(date, item.time ?? allDayTime);
}

/**
 * Upcoming reminder fire times, soonest first.
 * Skips completed occurrences, undated items, and reminders already in the past.
 * @returns {{itemId:string,date:string,reminderId:string,fireAt:number}[]}
 */
export function upcomingReminders(items, now, { horizonDays = 14, limit = 200, allDayTime } = {}) {
  const today = toDateStr(now);
  const from = addDays(today, -1); // yesterday's occurrences can still have a future offset
  const to = addDays(today, horizonDays);
  const out = [];
  for (const item of items) {
    if (!item.date || !item.reminders.length) continue;
    for (const date of occurrencesBetween(item, from, to)) {
      if (isDoneOn(item, date)) continue;
      const start = occurrenceStart(item, date, allDayTime).getTime();
      for (const { offsetMin } of item.reminders) {
        const fireAt = start - offsetMin * 60000;
        if (fireAt > now.getTime()) {
          out.push({ itemId: item.id, date, reminderId: String(offsetMin), fireAt });
        }
      }
    }
  }
  out.sort((a, b) => a.fireAt - b.fireAt || a.itemId.localeCompare(b.itemId));
  return out.slice(0, limit);
}

export const alarmName = ({ itemId, date, reminderId }) => `rem|${itemId}|${date}|${reminderId}`;

export function parseAlarmName(name) {
  const parts = String(name).split('|');
  if (parts.length !== 4 || parts[0] !== 'rem') return null;
  return { itemId: parts[1], date: parts[2], reminderId: parts[3] };
}

/** A one-off (non-recurring) dated item that is not done and whose due moment has passed. */
export function isOverdue(item, now, allDayTime) {
  if (!item.date || item.recurrence || item.done) return false;
  if (item.time) return combine(item.date, item.time).getTime() < now.getTime();
  void allDayTime; // all-day items only become overdue once the day is over
  return item.date < toDateStr(now);
}

/**
 * Toolbar badge number: open items due today or earlier (one-off), plus today's
 * unfinished occurrence of recurring items. Missed past occurrences of recurring
 * items are deliberately not counted, so a daily habit cannot pile up a huge number.
 */
export function badgeCount(items, now) {
  const today = toDateStr(now);
  let n = 0;
  for (const item of items) {
    if (!item.date) continue;
    if (item.recurrence) {
      if (occurrencesBetween(item, today, today).length && !isDoneOn(item, today)) n++;
    } else if (!item.done && item.date <= today) {
      n++;
    }
  }
  return n;
}
