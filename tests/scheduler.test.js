import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend, createStore } from '../src/lib/store.js';
import {
  createScheduler, FIRED_KEY, MAX_ALARMS, MIDNIGHT_ALARM, SNOOZES_KEY, snoozeName, TICK_ALARM,
} from '../src/lib/scheduler.js';
import { alarmName } from '../src/lib/reminders.js';
import { createClock, createFakeChrome } from './helpers/fake-chrome.js';

// Wednesday 30 Sep 2026, 10:00 local
function setup() {
  const clock = createClock();
  const backend = createMemoryBackend();
  let n = 0;
  const store = createStore(backend, { now: clock.ms, newId: () => `i${++n}`, useLocks: false });
  const chrome = createFakeChrome(clock);
  const make = () => createScheduler({ api: chrome, store, backend, now: clock.now });
  return { clock, backend, store, chrome, sched: make(), make };
}

const at = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
};
const remName = (itemId, date, offset) => alarmName({ itemId, date, reminderId: String(offset) });

test('sync creates one alarm per upcoming reminder, plus tick and midnight', async () => {
  const { store, chrome, sched } = setup();
  const a = await store.add({ title: 'Dentist', date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }, { offsetMin: 1440 }] });
  await store.add({ title: 'no reminder', date: '2026-10-01' });
  await store.add({ title: 'undated', reminders: [{ offsetMin: 5 }] });
  await sched.sync();
  assert.deepEqual(chrome.alarmNames(), [remName(a.id, '2026-10-01', 10), remName(a.id, '2026-10-01', 1440)].sort());
  assert.equal(chrome._alarms.get(remName(a.id, '2026-10-01', 10)).scheduledTime, at('2026-10-01', '14:50'));
  assert.ok(chrome._alarms.has(TICK_ALARM));
  assert.equal(chrome._alarms.get(TICK_ALARM).periodInMinutes, 60);
  assert.equal(chrome._alarms.get(MIDNIGHT_ALARM).scheduledTime, new Date(2026, 9, 1, 0, 0, 2).getTime());
});

test('sync is idempotent: a second run creates nothing', async () => {
  const { store, chrome, sched } = setup();
  await store.add({ title: 'x', date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }] });
  await sched.sync();
  const before = chrome._log.alarmCreates.length;
  await sched.sync();
  assert.equal(chrome._log.alarmCreates.length, before);
  assert.equal(chrome._log.alarmClears.length, 0);
});

test('editing, completing or deleting an item removes its stale alarms', async () => {
  const { store, chrome, sched } = setup();
  const a = await store.add({ title: 'x', date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }] });
  await sched.sync();
  await store.update(a.id, { time: '16:00' });
  await sched.sync();
  assert.equal(chrome._alarms.get(remName(a.id, '2026-10-01', 10)).scheduledTime, at('2026-10-01', '15:50'));
  await store.setDone(a.id, true);
  await sched.sync();
  assert.deepEqual(chrome.alarmNames(), []);
  await store.setDone(a.id, false);
  await sched.sync();
  assert.equal(chrome.alarmNames().length, 1);
  await store.remove(a.id);
  await sched.sync();
  assert.deepEqual(chrome.alarmNames(), []);
});

test('recurring items get an alarm for each upcoming occurrence; completed ones are skipped', async () => {
  const { store, chrome, sched } = setup();
  const a = await store.add({ title: 'meds', date: '2026-09-28', time: '20:00', recurrence: { freq: 'daily' }, reminders: [{ offsetMin: 0 }] });
  await store.setDone(a.id, true, '2026-10-02');
  await sched.sync();
  const dates = chrome.alarmNames().map((n) => n.split('|')[2]);
  assert.ok(dates.includes('2026-09-30'));
  assert.ok(!dates.includes('2026-10-02'));
  assert.equal(dates.length, 14); // today + 14 days ahead, minus the completed one
});

test('alarm count is capped', async () => {
  const { store, chrome, sched } = setup();
  for (let i = 0; i < MAX_ALARMS + 20; i++) await store.add({ title: `t${i}`, date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }] });
  await sched.sync();
  assert.equal(chrome.alarmNames().length, MAX_ALARMS);
});

test('firing an alarm shows one notification with Snooze and Mark done', async () => {
  const { store, chrome, sched, backend, clock } = setup();
  const work = await store.addCategory({ name: 'Work' });
  const a = await store.add({ title: 'Team sync', date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }], categoryId: work.id });
  await sched.sync();
  clock.set(new Date(2026, 9, 1, 14, 50));
  const name = remName(a.id, '2026-10-01', 10);
  await sched.handleAlarm({ name });
  const n = chrome._notifications.get(name);
  assert.equal(n.title, 'Team sync');
  assert.match(n.message, /Today · 15:00/);
  assert.match(n.message, /Work/);
  assert.equal(n.contextMessage, 'Reminder · 10 min before');
  assert.deepEqual(n.buttons.map((b) => b.title), ['Snooze 10 min', 'Mark done']);
  assert.equal(n.requireInteraction, true);
  assert.equal(n.iconUrl, 'chrome-extension://fake-id/icons/icon-128.png'); // a full URL, never a relative path
  assert.ok((await backend.get(FIRED_KEY))[`${a.id}|2026-10-01|10`]);

  chrome._notifications.clear();
  await sched.handleAlarm({ name }); // duplicate delivery
  assert.equal(chrome._notifications.size, 0);
});

test('an alarm for a completed, deleted or edited-away reminder shows nothing', async () => {
  const { store, chrome, sched } = setup();
  const a = await store.add({ title: 'x', date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }] });
  const name = remName(a.id, '2026-10-01', 10);
  await store.update(a.id, { reminders: [{ offsetMin: 30 }] });
  await sched.handleAlarm({ name });
  assert.equal(chrome._notifications.size, 0);
  await store.setDone(a.id, true);
  await sched.handleAlarm({ name: remName(a.id, '2026-10-01', 30) });
  assert.equal(chrome._notifications.size, 0);
  await store.remove(a.id);
  await sched.handleAlarm({ name });
  assert.equal(chrome._notifications.size, 0);
  await sched.handleAlarm({ name: 'something-else' });
  await sched.handleAlarm({ name: 'rem|broken' });
  assert.equal(chrome._notifications.size, 0);
});

test('Snooze: clears the notification, schedules a later one, and survives a restart', async () => {
  const { store, chrome, sched, backend, clock, make } = setup();
  await store.updateSettings({ snoozeMin: 15 });
  const a = await store.add({ title: 'Call', date: '2026-09-30', time: '10:30', reminders: [{ offsetMin: 10 }] });
  const name = remName(a.id, '2026-09-30', 10);
  clock.set(new Date(2026, 8, 30, 10, 20));
  await sched.handleAlarm({ name });
  assert.equal(chrome._notifications.get(name).buttons[0].title, 'Snooze 15 min');

  await sched.handleButton(name, 0);
  assert.equal(chrome._notifications.has(name), false);
  const snz = snoozeName(a.id, '2026-09-30');
  assert.equal(chrome._alarms.get(snz).scheduledTime, at('2026-09-30', '10:35'));
  assert.equal((await backend.get(SNOOZES_KEY))[snz].fireAt, at('2026-09-30', '10:35'));

  // Simulate the browser restarting: alarms are gone, a fresh scheduler re-derives them.
  chrome._alarms.clear();
  await make().sync();
  assert.equal(chrome._alarms.get(snz).scheduledTime, at('2026-09-30', '10:35'));

  clock.set(new Date(2026, 8, 30, 10, 35));
  await sched.handleAlarm({ name: snz });
  const n = chrome._notifications.get(snz);
  assert.equal(n.title, 'Call');
  assert.equal(n.contextMessage, 'Snoozed reminder');
  assert.deepEqual((await backend.get(SNOOZES_KEY)) ?? {}, {}); // consumed

  await sched.handleButton(snz, 0); // snooze again from the snoozed notification
  assert.ok(chrome._alarms.has(snz));
});

test('Mark done: completes the item, clears the notification and its alarms, updates the badge', async () => {
  const { store, chrome, sched, clock } = setup();
  const a = await store.add({ title: 'Report', date: '2026-09-30', time: '11:00', reminders: [{ offsetMin: 10 }, { offsetMin: 60 }] });
  await sched.sync();
  assert.equal(chrome._action.text, '1');
  clock.set(new Date(2026, 8, 30, 10, 50));
  const name = remName(a.id, '2026-09-30', 10);
  await sched.handleAlarm({ name });
  await sched.handleButton(name, 1);
  assert.equal((await store.get(a.id)).done, true);
  assert.equal(chrome._notifications.has(name), false);
  assert.deepEqual(chrome.alarmNames(), []);
  assert.equal(chrome._action.text, '');
});

test('Mark done on a recurring item completes only that occurrence', async () => {
  const { store, chrome, sched, clock } = setup();
  const a = await store.add({ title: 'Meds', date: '2026-09-28', time: '20:00', recurrence: { freq: 'daily' }, reminders: [{ offsetMin: 0 }] });
  clock.set(new Date(2026, 8, 30, 20, 0));
  const name = remName(a.id, '2026-09-30', 0);
  await sched.handleAlarm({ name });
  await sched.handleButton(name, 1);
  const cur = await store.get(a.id);
  assert.deepEqual(cur.completedDates, ['2026-09-30']);
  assert.equal(cur.done, false);
  assert.ok(chrome.alarmNames().includes(remName(a.id, '2026-10-01', 0))); // tomorrow's survives
});

test('a snooze is dropped when its item is completed elsewhere', async () => {
  const { store, chrome, sched, backend, clock } = setup();
  const a = await store.add({ title: 'x', date: '2026-09-30', time: '10:30', reminders: [{ offsetMin: 10 }] });
  const name = remName(a.id, '2026-09-30', 10);
  clock.set(new Date(2026, 8, 30, 10, 20));
  await sched.handleAlarm({ name });
  await sched.handleButton(name, 0);
  await store.setDone(a.id, true); // e.g. ticked in the popup
  await sched.sync();
  assert.equal(chrome._alarms.has(snoozeName(a.id, '2026-09-30')), false);
  assert.deepEqual((await backend.get(SNOOZES_KEY)) ?? {}, {});
});

test('clicking a notification dismisses it and tries to open the popup', async () => {
  const { chrome, sched } = setup();
  chrome._notifications.set('rem|a|2026-10-01|10', {});
  await sched.handleClick('rem|a|2026-10-01|10');
  assert.equal(chrome._notifications.size, 0);
  assert.equal(chrome._log.popupOpens, 1);
});

test('badge: count, 99+, colour turns red when something is overdue', async () => {
  const { store, chrome, sched } = setup();
  await sched.sync();
  assert.equal(chrome._action.text, '');
  assert.equal(chrome._action.title, 'Dayline');
  await store.add({ title: 'today', date: '2026-09-30' });
  await sched.sync();
  assert.equal(chrome._action.text, '1');
  assert.equal(chrome._action.color, '#4f46e5');
  await store.add({ title: 'late', date: '2026-09-28' });
  await sched.sync();
  assert.equal(chrome._action.text, '2');
  assert.equal(chrome._action.color, '#d42a48');
  assert.match(chrome._action.title, /2 open.*overdue/);
  for (let i = 0; i < 100; i++) await store.add({ title: `t${i}`, date: '2026-09-30' });
  await sched.sync();
  assert.equal(chrome._action.text, '99+');
});

test('the midnight alarm re-syncs, refreshes the badge and schedules the next midnight', async () => {
  const { store, chrome, sched, clock } = setup();
  await store.add({ title: 'tomorrow', date: '2026-10-01' });
  await sched.sync();
  assert.equal(chrome._action.text, '');
  clock.set(new Date(2026, 9, 1, 0, 0, 2));
  chrome._alarms.delete(MIDNIGHT_ALARM); // Chrome removes a one-off alarm once it fires
  await sched.handleAlarm({ name: MIDNIGHT_ALARM });
  assert.equal(chrome._action.text, '1');
  assert.equal(chrome._alarms.get(MIDNIGHT_ALARM).scheduledTime, new Date(2026, 9, 2, 0, 0, 2).getTime());
});

test('the hourly tick picks up reminders that just entered the horizon', async () => {
  const { store, chrome, sched, clock } = setup();
  const far = await store.add({ title: 'far', date: '2026-10-20', time: '09:00', reminders: [{ offsetMin: 10 }] });
  await sched.sync();
  assert.deepEqual(chrome.alarmNames(), []);
  clock.set(new Date(2026, 9, 10, 10, 0));
  await sched.handleAlarm({ name: TICK_ALARM });
  assert.deepEqual(chrome.alarmNames(), [remName(far.id, '2026-10-20', 10)]);
});

test('large offsets are found even when the occurrence is beyond the horizon', async () => {
  const { store, chrome, sched } = setup();
  const a = await store.add({ title: 'exam', date: '2026-10-20', time: '09:00', reminders: [{ offsetMin: 10 * 1440 }] });
  await sched.sync(); // reminder fires 10 Oct, within 14 days, though the exam is on the 20th
  assert.deepEqual(chrome.alarmNames(), [remName(a.id, '2026-10-20', 10 * 1440)]);
});

test('multi-day item: one reminder before day one, and the range in the message', async () => {
  const { store, chrome, sched, clock } = setup();
  const a = await store.add({ title: 'Job Fair', date: '2026-10-07', endDate: '2026-10-08', time: '09:00', reminders: [{ offsetMin: 60 }] });
  await sched.sync();
  assert.deepEqual(chrome.alarmNames(), [remName(a.id, '2026-10-07', 60)]);
  clock.set(new Date(2026, 9, 7, 8, 0));
  await sched.handleAlarm({ name: remName(a.id, '2026-10-07', 60) });
  const n = chrome._notifications.get(remName(a.id, '2026-10-07', 60));
  assert.match(n.message, /Wed 7 – Thu 8 Oct/);
  assert.match(n.message, /from 09:00/);
});

// ---------- catch-up ----------

test('boot shows reminders missed while the browser was closed, once', async () => {
  const { store, chrome, sched, clock, make } = setup();
  await store.add({ title: 'Standup', date: '2026-09-30', time: '10:30', reminders: [{ offsetMin: 30 }] }); // fired 10:00 (now)... 
  const b = await store.add({ title: 'Gym', date: '2026-09-30', time: '11:00', reminders: [{ offsetMin: 10 }] }); // due 10:50
  clock.set(new Date(2026, 8, 30, 10, 55)); // browser opened at 10:55
  await sched.boot();
  const ids = [...chrome._notifications.keys()];
  assert.ok(ids.includes(remName(b.id, '2026-09-30', 10)));
  assert.equal(ids.length, 2);
  chrome._notifications.clear();
  await make().boot(); // next start: nothing new
  assert.equal(chrome._notifications.size, 0);
});

test('catch-up skips stale timed events, completed ones and old reminders', async () => {
  const { store, chrome, sched, clock } = setup();
  await store.add({ title: 'Already started', date: '2026-09-30', time: '09:00', reminders: [{ offsetMin: 10 }] }); // started 10:00-... >30min ago
  const done = await store.add({ title: 'Done', date: '2026-09-30', time: '10:40', reminders: [{ offsetMin: 10 }] });
  await store.setDone(done.id, true);
  await store.add({ title: 'Yesterday', date: '2026-09-29', time: '10:00', reminders: [{ offsetMin: 10 }] });
  clock.set(new Date(2026, 8, 30, 10, 45));
  await sched.boot();
  assert.equal(chrome._notifications.size, 0);
});

test('catch-up keeps all-day and multi-day reminders relevant for the whole day', async () => {
  const { store, chrome, sched, clock } = setup();
  const allDay = await store.add({ title: 'Rent', date: '2026-09-30', reminders: [{ offsetMin: 0 }] }); // 09:00
  const span = await store.add({ title: 'Trip', date: '2026-09-30', endDate: '2026-10-02', time: '08:00', reminders: [{ offsetMin: 0 }] });
  clock.set(new Date(2026, 8, 30, 15, 0));
  await sched.boot();
  const ids = [...chrome._notifications.keys()].sort();
  assert.deepEqual(ids, [remName(allDay.id, '2026-09-30', 0), remName(span.id, '2026-09-30', 0)].sort());
});

test('catch-up shows at most 5 notifications and one summary for the rest', async () => {
  const { store, chrome, sched, clock } = setup();
  for (let i = 0; i < 8; i++) await store.add({ title: `t${i}`, date: '2026-09-30', time: '10:30', reminders: [{ offsetMin: 30 }] });
  clock.set(new Date(2026, 8, 30, 10, 10));
  await sched.boot();
  assert.equal(chrome._notifications.size, 6);
  assert.match(chrome._notifications.get('dl-missed').message, /^3 more reminders were missed/);
});

test('a reminder shown by its alarm is not repeated by catch-up', async () => {
  const { store, chrome, sched, clock } = setup();
  const a = await store.add({ title: 'x', date: '2026-09-30', time: '10:30', reminders: [{ offsetMin: 10 }] });
  clock.set(new Date(2026, 8, 30, 10, 20));
  await sched.handleAlarm({ name: remName(a.id, '2026-09-30', 10) });
  chrome._notifications.clear();
  clock.set(new Date(2026, 8, 30, 10, 25));
  await sched.boot();
  assert.equal(chrome._notifications.size, 0);
});

test('errors in one operation do not block the queue', async () => {
  const { store, chrome, sched, make } = setup();
  const broken = createScheduler({
    api: chrome, backend: createMemoryBackend(), now: () => new Date(2026, 8, 30, 10, 0),
    store: { getState: async () => { throw new Error('storage down'); } },
  });
  const origError = console.error;
  console.error = () => {};
  await assert.rejects(() => broken.sync(), /storage down/);
  console.error = origError;
  await store.add({ title: 'x', date: '2026-09-30' });
  await sched.sync();
  assert.equal(chrome._action.text, '1');
  await broken.whenIdle(); // the queue itself is still usable
  void make;
});
