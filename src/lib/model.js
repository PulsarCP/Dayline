// Item model: validation/normalisation. Every item that enters storage (new,
// edited or imported from a file) goes through normalizeItem(), which builds a
// fresh object from known fields only, so unknown or hostile keys never persist.

import { isValidDateStr, isValidTimeStr, timeToMinutes } from './dates.js';
import { normalizeRecurrence } from './recurrence.js';

export const LIMITS = Object.freeze({
  title: 200,
  notes: 2000,
  reminders: 10,
  maxOffsetMin: 60 * 24 * 60, // 60 days
  completedDates: 1000,
  items: 5000,
});

export const TYPES = Object.freeze(['task', 'event']);

/**
 * Item shape:
 * {
 *   id, title, notes, type: 'task'|'event',
 *   date: 'YYYY-MM-DD'|null,        // null = general / undated
 *   time: 'HH:MM'|null,             // null = all-day (or undated)
 *   endTime: 'HH:MM'|null,
 *   recurrence: rule|null,
 *   reminders: [{ offsetMin }],     // minutes before the start
 *   done, doneAt,                   // non-recurring completion
 *   completedDates: ['YYYY-MM-DD'], // per-occurrence completion for recurring items
 *   createdAt, updatedAt            // epoch ms
 * }
 */
export function normalizeItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new TypeError('item must be an object');
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) {
    throw new TypeError('invalid id');
  }

  if (typeof raw.title !== 'string') throw new TypeError('title must be a string');
  const title = raw.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) throw new RangeError('title is required');
  if (title.length > LIMITS.title) throw new RangeError('title too long');

  let notes = '';
  if (raw.notes != null) {
    if (typeof raw.notes !== 'string') throw new TypeError('notes must be a string');
    notes = raw.notes.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (notes.length > LIMITS.notes) throw new RangeError('notes too long');
  }

  const type = raw.type ?? 'task';
  if (!TYPES.includes(type)) throw new RangeError('invalid type');

  const date = raw.date ?? null;
  if (date !== null && !isValidDateStr(date)) throw new RangeError('invalid date');

  let time = raw.time ?? null;
  if (time !== null && !isValidTimeStr(time)) throw new RangeError('invalid time');
  if (date === null) time = null;

  let endTime = raw.endTime ?? null;
  if (endTime !== null) {
    if (!isValidTimeStr(endTime)) throw new RangeError('invalid endTime');
    if (time === null) endTime = null;
    else if (timeToMinutes(endTime) <= timeToMinutes(time)) {
      throw new RangeError('endTime must be after time');
    }
  }

  const recurrence = date === null ? null : normalizeRecurrence(raw.recurrence);

  const done = raw.done === true;
  const doneAt = done ? (Number.isFinite(raw.doneAt) ? raw.doneAt : now) : null;

  let completedDates = [];
  if (recurrence && Array.isArray(raw.completedDates)) {
    completedDates = [...new Set(raw.completedDates.filter(isValidDateStr))]
      .sort()
      .slice(-LIMITS.completedDates);
  }

  const seen = new Set();
  const reminders = [];
  for (const r of Array.isArray(raw.reminders) ? raw.reminders : []) {
    const offsetMin = typeof r === 'number' ? r : r?.offsetMin;
    if (!Number.isInteger(offsetMin) || offsetMin < 0 || offsetMin > LIMITS.maxOffsetMin) {
      throw new RangeError('invalid reminder offset');
    }
    if (!seen.has(offsetMin)) {
      seen.add(offsetMin);
      reminders.push({ offsetMin });
    }
  }
  if (reminders.length > LIMITS.reminders) throw new RangeError('too many reminders');
  reminders.sort((a, b) => a.offsetMin - b.offsetMin);

  return {
    id: raw.id,
    title,
    notes,
    type,
    date,
    time,
    endTime,
    recurrence,
    reminders,
    done,
    doneAt,
    completedDates,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

/** Is this item (or this occurrence of a recurring item) completed? */
export function isDoneOn(item, date) {
  return item.recurrence ? item.completedDates.includes(date) : item.done;
}

export const DEFAULT_SETTINGS = Object.freeze({
  allDayReminderTime: '09:00', // when all-day items "start" for reminder purposes
  defaultReminderMin: 10, // minutes before start for new timed items; null = no default reminder
});

export function normalizeSettings(raw) {
  const t = raw?.allDayReminderTime;
  const m = raw?.defaultReminderMin;
  let defaultReminderMin = DEFAULT_SETTINGS.defaultReminderMin;
  if (m === null) defaultReminderMin = null;
  else if (Number.isInteger(m) && m >= 0 && m <= LIMITS.maxOffsetMin) defaultReminderMin = m;
  return {
    allDayReminderTime: isValidTimeStr(t) ? t : DEFAULT_SETTINGS.allDayReminderTime,
    defaultReminderMin,
  };
}
