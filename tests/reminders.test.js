import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmName, badgeCount, isOverdue, parseAlarmName, upcomingReminders } from '../src/lib/reminders.js';
import { normalizeItem } from '../src/lib/model.js';

// Wednesday 30 Sep 2026, 10:00 local
const NOW = new Date(2026, 8, 30, 10, 0, 0);
let n = 0;
const mk = (o) => normalizeItem({ id: `i${++n}`, title: 't', ...o });
const at = (date, time) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8)), ...time.split(':').map(Number)).getTime();

test('one reminder fires offset minutes before the start', () => {
  const it = mk({ date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 10 }] });
  const [r] = upcomingReminders([it], NOW);
  assert.equal(r.fireAt, at('2026-10-01', '14:50'));
  assert.equal(r.date, '2026-10-01');
  assert.equal(r.reminderId, '10');
});

test('several reminders per item, soonest first across items', () => {
  const a = mk({ date: '2026-10-01', time: '15:00', reminders: [{ offsetMin: 1440 }, { offsetMin: 10 }] });
  const b = mk({ date: '2026-10-01', time: '09:00', reminders: [{ offsetMin: 0 }] });
  const out = upcomingReminders([a, b], NOW);
  assert.deepEqual(out.map((r) => [r.itemId, r.reminderId]), [[a.id, '1440'], [b.id, '0'], [a.id, '10']]);
});

test('past reminders, undated items and completed items are skipped', () => {
  const past = mk({ date: '2026-09-30', time: '09:00', reminders: [{ offsetMin: 10 }] });
  const undated = mk({ reminders: [{ offsetMin: 10 }] });
  const done = mk({ date: '2026-10-01', time: '09:00', reminders: [{ offsetMin: 10 }], done: true });
  assert.deepEqual(upcomingReminders([past, undated, done], NOW), []);
});

test('all-day items fire relative to the all-day time (default 09:00, configurable)', () => {
  const it = mk({ date: '2026-10-01', reminders: [{ offsetMin: 60 }] });
  assert.equal(upcomingReminders([it], NOW)[0].fireAt, at('2026-10-01', '08:00'));
  assert.equal(upcomingReminders([it], NOW, { allDayTime: '07:30' })[0].fireAt, at('2026-10-01', '06:30'));
});

test('a reminder set the day before catches an early-morning event', () => {
  // Event tomorrow 00:30 with a 1h offset fires today 23:30, which is after NOW.
  const it = mk({ date: '2026-10-01', time: '00:30', reminders: [{ offsetMin: 60 }] });
  assert.equal(upcomingReminders([it], NOW)[0].fireAt, at('2026-09-30', '23:30'));
});

test('recurring items yield one reminder per upcoming occurrence, skipping completed ones', () => {
  const it = mk({
    date: '2026-09-28', time: '18:00', recurrence: { freq: 'daily' }, reminders: [{ offsetMin: 30 }],
    completedDates: ['2026-10-01'],
  });
  const out = upcomingReminders([it], NOW, { horizonDays: 3 });
  assert.deepEqual(out.map((r) => r.date), ['2026-09-30', '2026-10-02', '2026-10-03']);
});

test('limit and horizon are respected', () => {
  const it = mk({ date: '2026-09-28', time: '18:00', recurrence: { freq: 'daily' }, reminders: [{ offsetMin: 30 }] });
  assert.equal(upcomingReminders([it], NOW, { horizonDays: 30, limit: 5 }).length, 5);
  assert.equal(upcomingReminders([it], NOW, { horizonDays: 0 }).length, 1);
});

test('alarm names round-trip', () => {
  const parts = { itemId: 'abc-123', date: '2026-10-01', reminderId: '10' };
  assert.deepEqual(parseAlarmName(alarmName(parts)), parts);
  assert.equal(parseAlarmName('other'), null);
  assert.equal(parseAlarmName('rem|a|b'), null);
});

test('isOverdue', () => {
  assert.equal(isOverdue(mk({ date: '2026-09-29' }), NOW), true);
  assert.equal(isOverdue(mk({ date: '2026-09-30' }), NOW), false); // all-day today
  assert.equal(isOverdue(mk({ date: '2026-09-30', time: '09:00' }), NOW), true);
  assert.equal(isOverdue(mk({ date: '2026-09-30', time: '11:00' }), NOW), false);
  assert.equal(isOverdue(mk({ date: '2026-09-29', done: true }), NOW), false);
  assert.equal(isOverdue(mk({}), NOW), false);
  assert.equal(isOverdue(mk({ date: '2026-09-01', recurrence: { freq: 'daily' } }), NOW), false);
});

test('badgeCount: due today or earlier, open only; recurring counts only today', () => {
  const items = [
    mk({ date: '2026-09-25' }), // overdue -> 1
    mk({ date: '2026-09-30', time: '18:00' }), // today -> 1
    mk({ date: '2026-10-01' }), // tomorrow
    mk({ date: '2026-09-30', done: true }), // done
    mk({}), // undated
    mk({ date: '2026-09-01', recurrence: { freq: 'daily' } }), // today's occurrence -> 1
    mk({ date: '2026-09-01', recurrence: { freq: 'daily' }, completedDates: ['2026-09-30'] }), // done today
    mk({ date: '2026-09-01', recurrence: { freq: 'weekly', weekdays: [1] } }), // Monday only
  ];
  assert.equal(badgeCount(items, NOW), 3);
});

test('isOverdue for multi-day items: due at the end of the last day', () => {
  assert.equal(isOverdue(mk({ date: '2026-09-28', endDate: '2026-09-30', time: '08:00' }), NOW), false);
  assert.equal(isOverdue(mk({ date: '2026-09-27', endDate: '2026-09-29' }), NOW), true);
  assert.equal(isOverdue(mk({ date: '2026-09-28', endDate: '2026-09-30', time: '08:00', endTime: '09:00' }), NOW), true);
  assert.equal(isOverdue(mk({ date: '2026-09-28', endDate: '2026-09-30', time: '08:00', endTime: '18:00' }), NOW), false);
});

test('reminders of a multi-day item fire before its first day only', () => {
  const it = mk({ date: '2026-10-07', endDate: '2026-10-09', time: '09:00', reminders: [{ offsetMin: 60 }] });
  assert.deepEqual(upcomingReminders([it], NOW).map((r) => r.date), ['2026-10-07']);
});

test('badgeCount: an ongoing multi-day item counts once; a future one does not', () => {
  const ongoing = mk({ date: '2026-09-29', endDate: '2026-10-02' });
  const future = mk({ date: '2026-10-05', endDate: '2026-10-06' });
  assert.equal(badgeCount([ongoing, future], NOW), 1);
});
