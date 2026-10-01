// Reminder scheduling maths. Pure functions: no chrome.* calls, so it is testable
// in Node. The background worker (phase 3) turns these results into chrome.alarms.

import { addDays, combine, toDateStr } from './dates.js';
import { DEFAULT_SETTINGS, isDoneOn } from './model.js';
import { occurrencesBetween, slotsOn } from './recurrence.js';

/** Start moment of an occurrence. All-day items count as `allDayTime` (default 09:00). */
export function occurrenceStart(item, date, allDayTime = DEFAULT_SETTINGS.allDayReminderTime, slot = null) {
  return combine(date, slot ?? item.time ?? allDayTime);
}

/**
 * Every reminder whose fire time lies in (fromMs, toMs], soonest first.
 * Skips completed occurrences and undated items. A multi-day item reminds before its
 * first day only. Offsets up to 60 days are honoured, so occurrences are searched that
 * far past `toMs`.
 * @returns {{itemId:string,date:string,reminderId:string,fireAt:number}[]}
 */
export function remindersBetween(items, fromMs, toMs, { allDayTime } = {}) {
  const fromDay = toDateStr(new Date(fromMs));
  const toDay = toDateStr(new Date(toMs));
  const out = [];
  for (const item of items) {
    if (!item.date || !item.reminders.length) continue;
    const maxOffset = Math.max(...item.reminders.map((r) => r.offsetMin));
    const lastDay = addDays(toDay, Math.ceil(maxOffset / 1440));
    for (const date of occurrencesBetween(item, fromDay, lastDay)) {
      if (isDoneOn(item, date)) continue;
      const hourly = item.recurrence?.freq === 'hourly';
      for (const slot of hourly ? slotsOn(item, date) : [null]) {
        const start = occurrenceStart(item, date, allDayTime, slot).getTime();
        for (const { offsetMin } of item.reminders) {
          const fireAt = start - offsetMin * 60000;
          if (fireAt > fromMs && fireAt <= toMs) {
            const reminderId = hourly ? `${offsetMin}@${slot}` : String(offsetMin);
            out.push({ itemId: item.id, date, reminderId, fireAt });
          }
        }
      }
    }
  }
  out.sort((a, b) => a.fireAt - b.fireAt || a.itemId.localeCompare(b.itemId));
  return out;
}

/** Upcoming reminders: from `now` to the end of the day `horizonDays` ahead. */
export function upcomingReminders(items, now, { horizonDays = 14, limit = 200, allDayTime } = {}) {
  const end = combine(addDays(toDateStr(now), horizonDays + 1), '00:00').getTime() - 1;
  return remindersBetween(items, now.getTime(), end, { allDayTime }).slice(0, limit);
}

/** Reminders that should have fired in the last `lookbackMin` minutes (browser was closed, etc.). */
export function missedReminders(items, now, { lookbackMin = 720, allDayTime } = {}) {
  return remindersBetween(items, now.getTime() - lookbackMin * 60000, now.getTime(), { allDayTime });
}

/**
 * Is a missed reminder still worth showing? A timed occurrence stops mattering shortly
 * after it starts; an all-day or multi-day one matters until its last day is over.
 */
export function isStillRelevant(item, date, now, { allDayTime, graceMin = 30, slot = null } = {}) {
  if (item.time && !item.endDate) {
    return occurrenceStart(item, date, allDayTime, slot).getTime() + graceMin * 60000 > now.getTime();
  }
  const lastDay = item.endDate ?? date;
  return lastDay >= toDateStr(now);
}

/** Offset (minutes) and optional hourly slot ("HH:MM") encoded in a reminder id. */
export function splitReminderId(reminderId) {
  const [offset, slot = null] = String(reminderId).split('@');
  return { offsetMin: Number(offset), slot };
}

export const alarmName = ({ itemId, date, reminderId }) => `rem|${itemId}|${date}|${reminderId}`;

export function parseAlarmName(name) {
  const parts = String(name).split('|');
  if (parts.length !== 4 || parts[0] !== 'rem') return null;
  return { itemId: parts[1], date: parts[2], reminderId: parts[3] };
}

/**
 * A one-off (non-recurring) dated item that is not done and whose due moment has passed.
 * A multi-day item is due at the end of its last day, not at its start.
 */
export function isOverdue(item, now, allDayTime) {
  if (!item.date || item.recurrence || item.done) return false;
  const today = toDateStr(now);
  if (item.endDate) {
    if (item.endDate < today) return true;
    if (item.endDate === today && item.endTime) {
      return combine(item.endDate, item.endTime).getTime() < now.getTime();
    }
    return false;
  }
  if (item.time) return combine(item.date, item.time).getTime() < now.getTime();
  void allDayTime; // all-day items only become overdue once the day is over
  return item.date < today;
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
