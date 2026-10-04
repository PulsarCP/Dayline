import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend, createStore } from '../src/lib/store.js';
import { createScheduler } from '../src/lib/scheduler.js';
import { normalizeItem, isDoneOn } from '../src/lib/model.js';
import { hourlyState } from '../src/lib/recurrence.js';
import { badgeCount, isOverdue, remindersBetween, alarmName } from '../src/lib/reminders.js';
import { buildViews } from '../src/lib/views.js';
import { filterAll } from '../src/lib/calendar.js';
import { parseQuickAdd } from '../src/lib/parser.js';
import { createClock, createFakeChrome } from './helpers/fake-chrome.js';

const at = (d, t) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
let n = 0;
const mk = (o) => normalizeItem({ id: `q${++n}`, title: 't', createdAt: n, ...o });
const water = (extra = {}) => mk({ date: '2026-10-04', time: '09:00', recurrence: { freq: 'hourly', interval: 5 }, ...extra });

test('defaults: checkable and showOnCalendar are on; false is kept; notes cannot be done', () => {
  const a = mk({});
  assert.equal(a.checkable, true);
  assert.equal(a.showOnCalendar, true);
  const b = mk({ checkable: false, showOnCalendar: false, done: true });
  assert.equal(b.checkable, false);
  assert.equal(b.showOnCalendar, false);
  assert.equal(b.done, false);
  assert.equal(isDoneOn(b, '2026-10-04'), false);
});

test('hourlyState: latest due slot is open until ticked, then the next one is shown', () => {
  const it = water(); // 09:00, 14:00, 19:00 on the 4th
  assert.deepEqual(hourlyState(it, at('2026-10-04', '08:00')), { slot: '09:00', done: false, next: '14:00' });
  assert.deepEqual(hourlyState(it, at('2026-10-04', '15:00')), { slot: '14:00', done: false, next: '19:00' });
  const ticked = { ...it, completedDates: ['2026-10-04@14:00'] };
  assert.deepEqual(hourlyState(ticked, at('2026-10-04', '15:00')), { slot: '14:00', done: true, next: '19:00' });
  assert.deepEqual(hourlyState(ticked, at('2026-10-04', '20:00')), { slot: '19:00', done: false, next: null });
  assert.equal(hourlyState(it, at('2026-10-03', '12:00')), null); // before it starts
  assert.equal(hourlyState(mk({ date: '2026-10-04' }), at('2026-10-04', '12:00')), null);
});

test('per-slot done: stored per slot, skipped by reminders, counted by the badge', async () => {
  const s = createStore(createMemoryBackend(), { now: () => 1, newId: () => 'w1', useLocks: false });
  await s.add({ title: 'Water', date: '2026-10-04', time: '09:00', recurrence: { freq: 'hourly', interval: 5 }, reminders: [{ offsetMin: 0 }] });
  const done = await s.setDone('w1', true, '2026-10-04@14:00');
  assert.deepEqual(done.completedDates, ['2026-10-04@14:00']);
  const from = at('2026-10-04', '08:00').getTime();
  const to = at('2026-10-04', '23:00').getTime();
  const rem = remindersBetween([done], from, to).map((r) => r.reminderId);
  assert.deepEqual(rem, ['0@09:00', '0@19:00']);
  assert.equal(badgeCount([done], at('2026-10-04', '14:30')), 0); // latest due slot ticked
  assert.equal(badgeCount([done], at('2026-10-04', '19:05')), 1); // next slot is due
  assert.equal(isDoneOn(done, '2026-10-04', '14:00'), true);
  assert.equal(isDoneOn(done, '2026-10-04'), false);
  await assert.rejects(() => createStore(createMemoryBackend(), { newId: () => 'x', useLocks: false }).setDone('nope', true, 'bad'));
});

test('restartHourly: re-anchors at now and ticks the current slot', async () => {
  const t = at('2026-10-04', '16:12').getTime();
  const s = createStore(createMemoryBackend(), { now: () => t, newId: () => 'w2', useLocks: false });
  await s.add({ title: 'Water', date: '2026-10-01', time: '09:00', recurrence: { freq: 'hourly', interval: 5 } });
  const r = await s.restartHourly('w2');
  assert.equal(r.date, '2026-10-04');
  assert.equal(r.time, '16:12');
  assert.deepEqual(r.completedDates, ['2026-10-04@16:12']);
  assert.deepEqual(hourlyState(r, at('2026-10-04', '16:30')), { slot: '16:12', done: true, next: '21:12' });
  await s.add({ title: 'Plain', id: 'p' });
  await assert.rejects(s.restartHourly('p'));
});

test('Today shows one row for an hourly item, with the due slot and the next one', () => {
  const it = water({ completedDates: ['2026-10-04@09:00'] });
  const v = buildViews([it], at('2026-10-04', '15:00'));
  assert.equal(v.today.rows.length, 1);
  assert.equal(v.today.rows[0].slot, '14:00');
  assert.equal(v.today.rows[0].next, '19:00');
  assert.equal(v.today.rows[0].done, false);
  assert.equal(v.counts.today, 1);
  const ticked = water({ completedDates: ['2026-10-04@14:00'] });
  const v2 = buildViews([ticked], at('2026-10-04', '15:00'));
  assert.equal(v2.today.rows.length, 0); // done rows are hidden
  assert.equal(buildViews([ticked], at('2026-10-04', '15:00'), { showDone: true }).today.completed.length, 0);
  assert.equal(buildViews([ticked], at('2026-10-04', '15:00'), { showDone: true }).today.rows[0].done, true);
});

test('items without a done checkbox are never overdue, never counted, and vanish after their day', () => {
  const now = at('2026-10-04', '12:00');
  const old = mk({ date: '2026-10-01', checkable: false });
  const today = mk({ date: '2026-10-04', time: '09:00', checkable: false });
  const gen = mk({ checkable: false });
  assert.equal(isOverdue(old, now), false);
  assert.equal(isOverdue(today, now), false);
  assert.equal(badgeCount([old, today, gen], now), 0);
  const v = buildViews([old, today, gen], now);
  assert.equal(v.today.overdue.length, 0);
  assert.deepEqual(v.today.rows.map((r) => r.item.id), [today.id]);
  assert.deepEqual(v.counts, { today: 0, upcoming: 0, general: 0 });
  assert.equal(v.general.length, 1);
  assert.deepEqual(filterAll([old, today, gen], { status: 'open' }, now).map((i) => i.id), [today.id, gen.id]);
  assert.deepEqual(filterAll([old, today, gen], { status: 'done' }, now).map((i) => i.id), [old.id]);
});

test('notifications for items without a checkbox only offer Snooze; hourly Mark done ticks the slot', async () => {
  const clock = createClock();
  const backend = createMemoryBackend();
  let k = 0;
  const store = createStore(backend, { now: clock.ms, newId: () => `i${++k}`, useLocks: false });
  const chrome = createFakeChrome(clock);
  const sched = createScheduler({ api: chrome, store, backend, now: clock.now });
  const note = await store.add({ title: 'Note', date: '2026-10-01', time: '15:00', checkable: false, reminders: [{ offsetMin: 10 }] });
  const hr = await store.add({ title: 'Water', date: '2026-10-01', time: '09:00', recurrence: { freq: 'hourly', interval: 5 }, reminders: [{ offsetMin: 0 }] });
  clock.set(new Date(2026, 9, 1, 14, 50));
  const nName = alarmName({ itemId: note.id, date: '2026-10-01', reminderId: '10' });
  await sched.handleAlarm({ name: nName });
  assert.deepEqual(chrome._notifications.get(nName).buttons.map((b) => b.title), ['Snooze 10 min']);
  clock.set(new Date(2026, 9, 1, 14, 0));
  const hName = alarmName({ itemId: hr.id, date: '2026-10-01', reminderId: '0@14:00' });
  await sched.handleAlarm({ name: hName });
  assert.match(chrome._notifications.get(hName).message, /14:00/);
  await sched.handleButton(hName, 1);
  const after = await store.get(hr.id);
  assert.deepEqual(after.completedDates, ['2026-10-01@14:00']);
  assert.equal(chrome._notifications.has(hName), false);
});

test('quick-add: weekday ranges', () => {
  const now = at('2026-10-04', '16:00'); // Sunday
  const rep = parseQuickAdd('gym every monday to friday 7am', now);
  assert.deepEqual(rep.recurrence.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(rep.title, 'gym');
  assert.deepEqual(parseQuickAdd('study every Mon-Fri', now).recurrence.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseQuickAdd('pills on weekdays 8am', now).recurrence.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseQuickAdd('every fri-mon x', now).recurrence.weekdays, [0, 1, 5, 6]);
  const span = parseQuickAdd('conference monday to friday 9am', now);
  assert.equal(span.recurrence, null);
  assert.equal(span.date, '2026-10-05');
  assert.equal(span.endDate, '2026-10-09');
  assert.equal(span.time, '09:00');
  const wrap = parseQuickAdd('retreat fri-sun', now);
  assert.deepEqual([wrap.date, wrap.endDate], ['2026-10-09', '2026-10-11']);
  assert.equal(parseQuickAdd('class mon-mon', now).title, 'class mon-mon');
  assert.equal(parseQuickAdd('report friday', now).endDate, null);
});
