// Reminder scheduler: keeps chrome.alarms in step with the stored items, shows the
// notifications, handles Snooze / Mark done, catches up on reminders missed while the
// browser was closed, and maintains the toolbar badge.
//
// It takes the chrome API as a parameter, so it runs against a fake in Node tests.
// Nothing here keeps state in memory that matters: an MV3 service worker can be killed
// at any moment, so everything is re-derived from storage (items, plus two small
// bookkeeping keys: pending snoozes and already-shown reminders).
//
// All operations run one at a time (a promise queue), because several alarms and
// storage events can wake the worker at once and the bookkeeping keys are
// read-modify-write.

import { toDateStr } from './dates.js';
import { DEFAULT_SETTINGS, isDoneOn } from './model.js';
import { hourlyState, occurrenceKey, occurrencesBetween } from './recurrence.js';
import {
  alarmName, badgeCount, isOverdue, isStillRelevant, missedReminders, parseAlarmName,
  splitReminderId, upcomingReminders,
} from './reminders.js';
import {
  categoryOf, formatDay, formatRange, formatWhen, offsetLabel,
} from './views.js';

export const SNOOZES_KEY = 'dayline:snoozes';
export const FIRED_KEY = 'dayline:fired';
export const TICK_ALARM = 'dl-tick';
export const MIDNIGHT_ALARM = 'dl-midnight';
export const HORIZON_DAYS = 14;
export const MAX_ALARMS = 300;
export const CATCH_UP_LOOKBACK_MIN = 720;
export const MAX_CATCH_UP_NOTIFICATIONS = 5;
const FIRED_KEEP_MS = 3 * 24 * 3600 * 1000;
const SNOOZE_PREFIX = 'snz';
const BADGE_COLORS = { normal: '#4f46e5', overdue: '#d42a48' };
const ICON_PATH = 'icons/icon-128.png';

export const snoozeName = (itemId, date) => `${SNOOZE_PREFIX}|${itemId}|${date}`;

export function parseSnoozeName(name) {
  const parts = String(name).split('|');
  if (parts.length !== 3 || parts[0] !== SNOOZE_PREFIX) return null;
  return { itemId: parts[1], date: parts[2] };
}

const firedKey = ({ itemId, date, reminderId }) => `${itemId}|${date}|${reminderId}`;

/**
 * @param {{
 *   api: {alarms: object, notifications: object, action: object},
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   backend: {get(key): Promise<any>, set(key, value): Promise<void>},
 *   now?: () => Date,
 * }} deps
 */
export function createScheduler({ api, store, backend, now = () => new Date() }) {
  // A relative iconUrl is resolved against the calling script (src/...), not the extension
  // root, and Chrome then refuses the whole notification. Always pass a full extension URL.
  const icon = () => (api.runtime?.getURL ? api.runtime.getURL(ICON_PATH) : ICON_PATH);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.then(() => undefined, (e) => { console.error('[dayline]', e); });
    return run;
  };

  let syncTimer = null;

  const readMap = async (key) => {
    const v = await backend.get(key);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };

  // ---------- badge ----------

  async function doUpdateBadge(state) {
    const { items } = state;
    const t = now();
    const n = badgeCount(items, t);
    const late = items.some((it) => isOverdue(it, t));
    await api.action.setBadgeText({ text: n === 0 ? '' : n > 99 ? '99+' : String(n) });
    await api.action.setBadgeBackgroundColor({ color: late ? BADGE_COLORS.overdue : BADGE_COLORS.normal });
    if (api.action.setBadgeTextColor) await api.action.setBadgeTextColor({ color: '#ffffff' });
    if (api.action.setTitle) {
      await api.action.setTitle({ title: n === 0 ? 'Dayline' : `Dayline – ${n} open${late ? ' (some overdue)' : ''}` });
    }
  }

  // ---------- alarms ----------

  const nextMidnight = () => {
    const d = now();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 2).getTime();
  };

  async function doSync() {
    const state = await store.getState();
    const t = now();
    const settings = { ...DEFAULT_SETTINGS, ...state.settings };

    const desired = new Map(); // alarm name -> fire time (ms)
    for (const r of upcomingReminders(state.items, t, {
      horizonDays: HORIZON_DAYS, limit: MAX_ALARMS, allDayTime: settings.allDayReminderTime,
    })) {
      desired.set(alarmName(r), r.fireAt);
    }

    // Snoozes: drop the ones whose item or occurrence is gone or already done.
    const snoozes = await readMap(SNOOZES_KEY);
    let snoozesChanged = false;
    for (const [name, info] of Object.entries(snoozes)) {
      const p = parseSnoozeName(name);
      const item = p && state.items.find((it) => it.id === p.itemId);
      const valid = item && Number.isFinite(info?.fireAt) && occurrenceExists(item, p.date)
        && !isDoneOn(item, p.date);
      if (valid) desired.set(name, Math.max(info.fireAt, t.getTime() + 1000));
      else { delete snoozes[name]; snoozesChanged = true; }
    }
    if (snoozesChanged) await backend.set(SNOOZES_KEY, snoozes);

    const existing = await api.alarms.getAll();
    const byName = new Map(existing.map((a) => [a.name, a]));
    for (const a of existing) {
      if ((alarmParse(a.name) || parseSnoozeName(a.name)) && !desired.has(a.name)) {
        await api.alarms.clear(a.name);
      }
    }
    for (const [name, when] of desired) {
      const cur = byName.get(name);
      if (!cur || Math.abs(cur.scheduledTime - when) > 1000) await api.alarms.create(name, { when });
    }

    if (!byName.has(TICK_ALARM)) {
      await api.alarms.create(TICK_ALARM, { delayInMinutes: 60, periodInMinutes: 60 });
    }
    const mid = nextMidnight();
    const curMid = byName.get(MIDNIGHT_ALARM);
    if (!curMid || Math.abs(curMid.scheduledTime - mid) > 1000) {
      await api.alarms.create(MIDNIGHT_ALARM, { when: mid });
    }

    await doUpdateBadge(state);
  }

  const alarmParse = (name) => parseAlarmName(name);

  function occurrenceExists(item, date) {
    if (!item.date) return false;
    return occurrencesBetween(item, date, date).length > 0;
  }

  // ---------- notifications ----------

  // An hourly item shows the clock time of the slot that fired, not its first start.
  const slotItem = (item, parts) => {
    const { slot } = splitReminderId(parts.reminderId ?? '');
    return slot ? { ...item, time: slot, endTime: null } : item;
  };

  async function show(kind, parts, item, categories, settings) {
    const t = now();
    const today = toDateStr(t);
    const cat = categoryOf(item, categories);
    const when = item.endDate
      ? `${formatRange(item, today)}${item.time ? ` · from ${item.time}` : ''}`
      : `${formatDay(parts.date, today)} · ${formatWhen(slotItem(item, parts))}`;
    const context = kind === 'snz'
      ? 'Snoozed reminder'
      : `Reminder · ${offsetLabel(splitReminderId(parts.reminderId).offsetMin)}`;
    const id = kind === 'snz' ? snoozeName(parts.itemId, parts.date) : alarmName(parts);
    await api.notifications.create(id, {
      type: 'basic',
      iconUrl: icon(),
      title: item.title,
      message: cat ? `${when}  ·  ${cat.name}` : when,
      contextMessage: context,
      priority: 2,
      requireInteraction: true,
      buttons: item.checkable === false
        ? [{ title: `Snooze ${settings.snoozeMin} min` }]
        : [{ title: `Snooze ${settings.snoozeMin} min` }, { title: 'Mark done' }],
    });
  }

  /** Is this reminder still valid given the current data? Returns the item if so. */
  function validate(state, parts, kind) {
    const item = state.items.find((it) => it.id === parts.itemId);
    if (!item || !occurrenceExists(item, parts.date)) return null;
    const slot = kind === 'rem' ? splitReminderId(parts.reminderId).slot : null;
    if (isDoneOn(item, parts.date, slot)) return null;
    if (kind === 'rem' && !item.reminders.some((r) => r.offsetMin === splitReminderId(parts.reminderId).offsetMin)) {
      return null;
    }
    return item;
  }

  async function doFire(name) {
    const state = await store.getState();
    const settings = { ...DEFAULT_SETTINGS, ...state.settings };
    const rem = parseAlarmName(name);
    const snz = rem ? null : parseSnoozeName(name);
    if (!rem && !snz) return;

    if (snz) {
      const snoozes = await readMap(SNOOZES_KEY);
      delete snoozes[name];
      await backend.set(SNOOZES_KEY, snoozes);
      const item = validate(state, snz, 'snz');
      if (item) await show('snz', snz, item, state.categories, settings);
    } else {
      const item = validate(state, rem, 'rem');
      if (!item) return;
      const fired = await readMap(FIRED_KEY);
      if (fired[firedKey(rem)]) return; // already shown (e.g. by catch-up)
      fired[firedKey(rem)] = now().getTime();
      await backend.set(FIRED_KEY, pruneFired(fired));
      await show('rem', rem, item, state.categories, settings);
    }
    await doUpdateBadge(state);
  }

  function pruneFired(fired) {
    const cutoff = now().getTime() - FIRED_KEEP_MS;
    for (const [k, at] of Object.entries(fired)) if (!(at > cutoff)) delete fired[k];
    return fired;
  }

  async function doCatchUp() {
    const state = await store.getState();
    const settings = { ...DEFAULT_SETTINGS, ...state.settings };
    const t = now();
    const fired = await readMap(FIRED_KEY);
    const byId = new Map(state.items.map((it) => [it.id, it]));

    const due = missedReminders(state.items, t, {
      lookbackMin: CATCH_UP_LOOKBACK_MIN, allDayTime: settings.allDayReminderTime,
    }).filter((r) => {
      const item = byId.get(r.itemId);
      return !fired[firedKey(r)]
        && isStillRelevant(item, r.date, t, {
          allDayTime: settings.allDayReminderTime, slot: splitReminderId(r.reminderId).slot,
        });
    });

    // Record everything as handled so nothing is re-announced on the next start.
    for (const r of due) fired[firedKey(r)] = t.getTime();
    if (due.length) await backend.set(FIRED_KEY, pruneFired(fired));

    for (const r of due.slice(0, MAX_CATCH_UP_NOTIFICATIONS)) {
      await show('rem', r, byId.get(r.itemId), state.categories, settings);
    }
    const more = due.length - MAX_CATCH_UP_NOTIFICATIONS;
    if (more > 0) {
      await api.notifications.create('dl-missed', {
        type: 'basic',
        iconUrl: icon(),
        title: 'Dayline',
        message: `${more} more reminder${more === 1 ? ' was' : 's were'} missed while the browser was closed. Open Dayline to see them.`,
        priority: 1,
      });
    }
  }

  async function doSnooze(parts, settings) {
    const fireAt = now().getTime() + settings.snoozeMin * 60000;
    const name = snoozeName(parts.itemId, parts.date);
    const snoozes = await readMap(SNOOZES_KEY);
    snoozes[name] = { fireAt };
    await backend.set(SNOOZES_KEY, snoozes);
    await api.alarms.create(name, { when: fireAt });
  }

  async function doButton(id, index) {
    const parts = parseAlarmName(id) ?? parseSnoozeName(id);
    if (!parts) return;
    const state = await store.getState();
    const settings = { ...DEFAULT_SETTINGS, ...state.settings };
    await api.notifications.clear(id);
    if (index === 0) {
      await doSnooze(parts, settings);
    } else if (index === 1) {
      const item = state.items.find((it) => it.id === parts.itemId);
      if (item && item.checkable !== false) {
        let slot = parts.reminderId ? splitReminderId(parts.reminderId).slot : null;
        if (!slot && item.recurrence?.freq === 'hourly') {
          const st = hourlyState(item, now());
          if (st && parts.date === toDateStr(now())) slot = st.slot; // snoozed reminder: the slot now due
        }
        await store.setDone(parts.itemId, true, occurrenceKey(item, parts.date, slot));
      }
      const snoozes = await readMap(SNOOZES_KEY);
      delete snoozes[snoozeName(parts.itemId, parts.date)];
      await backend.set(SNOOZES_KEY, snoozes);
    }
    await doSync();
  }

  async function doClick(id) {
    await api.notifications.clear(id);
    try {
      await api.action.openPopup?.();
    } catch { /* needs a focused browser window; fine to skip */ }
  }

  // ---------- public API (each call is serialised) ----------

  return {
    /** Recompute alarms and the badge from storage. */
    sync: () => serial(doSync),
    /** Debounced sync for bursts of storage events. */
    requestSync(delayMs = 300) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => { this.sync(); }, delayMs);
    },
    /** Install/startup: show missed reminders, then sync. */
    boot: () => serial(async () => { await doCatchUp(); await doSync(); }),
    handleAlarm: (alarm) => serial(async () => {
      if (alarm.name === TICK_ALARM || alarm.name === MIDNIGHT_ALARM) return doSync();
      await doFire(alarm.name);
      return undefined;
    }),
    handleButton: (id, index) => serial(() => doButton(id, index)),
    handleClick: (id) => serial(() => doClick(id)),
    updateBadge: () => serial(async () => doUpdateBadge(await store.getState())),
    whenIdle: () => queue,
  };
}
