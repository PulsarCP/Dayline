// Minimal fake of the chrome.* surface the scheduler uses, plus a controllable clock.

export function createClock(start = new Date(2026, 8, 30, 10, 0, 0)) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    ms: () => t,
    set: (d) => { t = d.getTime(); },
    advance: (ms) => { t += ms; },
  };
}

export function createFakeChrome(clock) {
  const alarms = new Map();
  const notifications = new Map();
  const log = { alarmCreates: [], alarmClears: [], notifClears: [], popupOpens: 0 };
  const action = { text: '', color: null, title: null };

  return {
    runtime: { getURL: (path) => `chrome-extension://fake-id/${path}` },
    alarms: {
      async create(name, info) {
        const when = info.when ?? clock.ms() + (info.delayInMinutes ?? 0) * 60000;
        log.alarmCreates.push(name);
        alarms.set(name, { name, scheduledTime: when, periodInMinutes: info.periodInMinutes });
      },
      async getAll() { return [...alarms.values()].map((a) => ({ ...a })); },
      async clear(name) { log.alarmClears.push(name); return alarms.delete(name); },
    },
    notifications: {
      async create(id, opts) { notifications.set(id, structuredClone(opts)); return id; },
      async clear(id) { log.notifClears.push(id); return notifications.delete(id); },
    },
    action: {
      async setBadgeText({ text }) { action.text = text; },
      async setBadgeBackgroundColor({ color }) { action.color = color; },
      async setBadgeTextColor() {},
      async setTitle({ title }) { action.title = title; },
      async openPopup() { log.popupOpens++; },
    },
    // inspection helpers for tests
    _alarms: alarms,
    _notifications: notifications,
    _log: log,
    _action: action,
    alarmNames: () => [...alarms.keys()].filter((n) => n.startsWith('rem|') || n.startsWith('snz|')).sort(),
  };
}
