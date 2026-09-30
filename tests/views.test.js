import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem } from '../src/lib/model.js';
import {
  buildViews, formatDate, formatDay, formatWhen, offsetLabel, remindersFor, remindersSummary, repeatLabel,
} from '../src/lib/views.js';

// Wednesday 30 Sep 2026, 10:00 local
const NOW = new Date(2026, 8, 30, 10, 0, 0);
let n = 0;
const mk = (o) => normalizeItem({ id: `v${++n}`, title: `item${n}`, createdAt: n, updatedAt: n, ...o });
const titles = (rows) => rows.map((r) => r.item.title);

test('sections: overdue, today, upcoming groups, later, general', () => {
  const items = [
    mk({ title: 'late', date: '2026-09-28' }),
    mk({ title: 'late timed today', date: '2026-09-30', time: '09:00' }),
    mk({ title: 'today allday', date: '2026-09-30' }),
    mk({ title: 'today evening', date: '2026-09-30', time: '18:00' }),
    mk({ title: 'tomorrow', date: '2026-10-01', time: '08:00' }),
    mk({ title: 'in a week', date: '2026-10-07' }),
    mk({ title: 'much later', date: '2026-12-01' }),
    mk({ title: 'someday' }),
  ];
  const v = buildViews(items, NOW);
  assert.deepEqual(titles(v.today.overdue), ['late', 'late timed today']);
  assert.deepEqual(titles(v.today.rows), ['today allday', 'today evening']);
  assert.deepEqual(v.upcoming.groups.map((g) => g.date), ['2026-10-01', '2026-10-07']);
  assert.deepEqual(titles(v.upcoming.later), ['much later']);
  assert.deepEqual(titles(v.general), ['someday']);
  assert.deepEqual(v.counts, { today: 4, upcoming: 3, general: 1 });
  assert.equal(v.today.overdue.every((r) => r.overdue), true);
});

test('completed items are hidden unless showDone, and stay in place when shown', () => {
  const items = [
    mk({ title: 'open today', date: '2026-09-30', time: '12:00' }),
    mk({ title: 'done today', date: '2026-09-30', time: '08:00', done: true, doneAt: 5 }),
    mk({ title: 'done last week', date: '2026-09-20', done: true, doneAt: 9 }),
    mk({ title: 'done general', done: true }),
    mk({ title: 'open general' }),
  ];
  const hidden = buildViews(items, NOW);
  assert.deepEqual(titles(hidden.today.rows), ['open today']);
  assert.deepEqual(titles(hidden.general), ['open general']);
  assert.deepEqual(hidden.today.completed, []);

  const shown = buildViews(items, NOW, { showDone: true });
  assert.deepEqual(titles(shown.today.rows), ['open today', 'done today']); // done rows sink
  assert.deepEqual(titles(shown.general), ['open general', 'done general']);
  assert.deepEqual(titles(shown.today.completed), ['done last week']);
  assert.deepEqual(shown.counts, { today: 1, upcoming: 0, general: 1 }); // counts only open
});

test('recurring items appear once per occurrence and complete per occurrence', () => {
  const it = mk({
    title: 'meds', date: '2026-09-01', time: '20:00', recurrence: { freq: 'daily' },
    completedDates: ['2026-09-30', '2026-10-02'],
  });
  const v = buildViews([it], NOW);
  assert.deepEqual(v.today.rows, []); // today's is done, hidden
  assert.deepEqual(v.upcoming.groups.map((g) => g.date), ['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  const shown = buildViews([it], NOW, { showDone: true });
  assert.equal(shown.today.rows[0].done, true);
  assert.equal(shown.today.rows[0].date, '2026-09-30');
  assert.equal(shown.upcoming.groups[1].rows[0].done, true);
  assert.equal(shown.counts.today, 0);
});

test('a missed recurring occurrence is not shown as overdue', () => {
  const it = mk({ date: '2026-09-01', recurrence: { freq: 'weekly', weekdays: [1] } });
  const v = buildViews([it], NOW);
  assert.deepEqual(v.today.overdue, []);
  assert.deepEqual(v.upcoming.groups.map((g) => g.date), ['2026-10-05']);
});

test('today rows: all-day first, then by time, done rows last', () => {
  const items = [
    mk({ title: 'b', date: '2026-09-30', time: '23:00' }),
    mk({ title: 'a', date: '2026-09-30', time: '22:00' }),
    mk({ title: 'allday', date: '2026-09-30' }),
    mk({ title: 'finished', date: '2026-09-30', time: '01:00', done: true }),
  ];
  assert.deepEqual(titles(buildViews(items, NOW, { showDone: true }).today.rows), ['allday', 'a', 'b', 'finished']);
});

test('formatDay', () => {
  assert.equal(formatDay('2026-09-30', '2026-09-30'), 'Today');
  assert.equal(formatDay('2026-10-01', '2026-09-30'), 'Tomorrow');
  assert.equal(formatDay('2026-09-29', '2026-09-30'), 'Yesterday');
  assert.equal(formatDay('2026-10-07', '2026-09-30'), 'Wed 7 Oct');
  assert.equal(formatDay('2027-01-05', '2026-09-30'), 'Tue 5 Jan 2027');
});

test('formatWhen / repeatLabel / offsetLabel / remindersSummary', () => {
  assert.equal(formatWhen(mk({ date: '2026-10-01' })), 'All day');
  assert.equal(formatWhen(mk({ date: '2026-10-01', time: '09:00' })), '09:00');
  assert.equal(formatWhen(mk({ date: '2026-10-01', time: '09:00', endTime: '10:30' })), '09:00–10:30');

  assert.equal(repeatLabel(null), '');
  assert.equal(repeatLabel({ freq: 'daily', interval: 1 }), 'Daily');
  assert.equal(repeatLabel({ freq: 'daily', interval: 3 }), 'Every 3 days');
  assert.equal(repeatLabel({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }), 'Weekdays');
  assert.equal(repeatLabel({ freq: 'weekly', interval: 1, weekdays: [1, 3] }), 'Weekly on Mon, Wed');
  assert.equal(repeatLabel({ freq: 'weekly', interval: 2 }), 'Every 2 weeks');
  assert.equal(repeatLabel({ freq: 'monthly', interval: 1 }), 'Monthly');

  assert.deepEqual([0, 10, 60, 120, 1440, 2880].map(offsetLabel), [
    'At start', '10 min before', '1 hour before', '2 hours before', '1 day before', '2 days before',
  ]);
  assert.equal(remindersSummary(mk({ date: '2026-10-01', reminders: [{ offsetMin: 10 }, { offsetMin: 1440 }] })), '10 min before, 1 day before');
});

test('remindersFor: undated none, all-day at the all-day time, timed uses the default', () => {
  assert.deepEqual(remindersFor({ date: null, time: null }, 10), []);
  assert.deepEqual(remindersFor({ date: '2026-10-01', time: null }, 10), [{ offsetMin: 0 }]);
  assert.deepEqual(remindersFor({ date: '2026-10-01', time: '15:00' }, 30), [{ offsetMin: 30 }]);
  assert.deepEqual(remindersFor({ date: '2026-10-01', time: '15:00' }, 0), [{ offsetMin: 0 }]);
  assert.deepEqual(remindersFor({ date: '2026-10-01', time: '15:00' }, null), []);
});

test('formatDate uses fixed three-letter months regardless of locale data', () => {
  assert.equal(formatDate('2026-09-28', '2026-09-30'), 'Mon 28 Sep');
  assert.equal(formatDate('2026-10-07', '2026-09-30'), 'Wed 7 Oct');
  assert.equal(formatDate('2027-01-05', '2026-09-30'), 'Tue 5 Jan 2027');
  assert.equal(formatDate('2026-09-30'), 'Wed 30 Sep');
});
