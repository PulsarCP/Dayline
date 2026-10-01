import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../src/lib/parser.js';
import { normalizeItem } from '../src/lib/model.js';
import { normalizeRecurrence, occurrencesBetween, slotsOn } from '../src/lib/recurrence.js';
import { remindersBetween, splitReminderId, alarmName, parseAlarmName } from '../src/lib/reminders.js';
import { repeatLabel } from '../src/lib/views.js';

const NOW = new Date(2026, 9, 1, 10, 2); // Thursday 1 Oct 2026, 10:02

test('quick-add: several weekdays', () => {
  const cases = {
    'gym every Thursday and Friday 7am': [4, 5],
    'every mon, wed & fri study': [1, 3, 5],
    'class every tue + thu': [2, 4],
    'every monday and wednesday and friday x': [1, 3, 5],
  };
  for (const [text, days] of Object.entries(cases)) {
    const p = parseQuickAdd(text, NOW);
    assert.deepEqual(p.recurrence, { freq: 'weekly', interval: 1, weekdays: days }, text);
    assert.ok(!/every|and|&/i.test(p.title), `${text} -> "${p.title}"`);
  }
  const p = parseQuickAdd('every other tue and thu call', NOW);
  assert.equal(p.recurrence.interval, 2);
  assert.deepEqual(p.recurrence.weekdays, [2, 4]);
  // first date is the next listed weekday on/after today (time not passed)
  assert.equal(parseQuickAdd('gym every Thursday and Friday 7am', NOW).date, '2026-10-02');
  assert.equal(parseQuickAdd('gym every Thursday and Friday 23:00', NOW).date, '2026-10-01');
});

test('quick-add: hourly', () => {
  let p = parseQuickAdd('drink water every 5 hours', NOW);
  assert.deepEqual(p.recurrence, { freq: 'hourly', interval: 5 });
  assert.equal(p.title, 'drink water');
  assert.equal(p.date, '2026-10-01');
  assert.equal(p.time, '10:05');
  p = parseQuickAdd('stretch every hour', NOW);
  assert.deepEqual(p.recurrence, { freq: 'hourly', interval: 1 });
  p = parseQuickAdd('pills every 2 hours at 9:00', NOW);
  assert.equal(p.time, '09:00');
  assert.equal(p.date, '2026-10-02');
  p = parseQuickAdd('pills hourly 14:00', NOW);
  assert.equal(p.recurrence.freq, 'hourly');
  assert.equal(p.date, '2026-10-01');
  // "in 2 hours" still means relative time, not a repeat
  assert.equal(parseQuickAdd('call in 2 hours', NOW).recurrence, null);
  // late evening: first slot rolls to the next day when needed
  const late = parseQuickAdd('walk every 3 hours', new Date(2026, 9, 1, 23, 58));
  assert.equal(late.date, '2026-10-02');
  assert.equal(late.time, '00:00');
});

test('hourly rule validation', () => {
  assert.deepEqual(normalizeRecurrence({ freq: 'hourly', interval: 5 }), { freq: 'hourly', interval: 5 });
  assert.throws(() => normalizeRecurrence({ freq: 'hourly', interval: 24 }));
  assert.throws(() => normalizeItem({ id: 'x1', title: 'x', date: '2026-10-01', recurrence: { freq: 'hourly', interval: 2 } }));
  const it = normalizeItem({ id: 'x1', title: 'x', date: '2026-10-01', time: '09:00', recurrence: { freq: 'hourly', interval: 2 } });
  assert.equal(it.recurrence.freq, 'hourly');
  assert.equal(repeatLabel(it.recurrence), 'Every 2 hours');
  assert.equal(repeatLabel({ freq: 'hourly', interval: 1 }), 'Every hour');
});

test('hourly slots run continuously across midnight', () => {
  const it = normalizeItem({ id: 'w1', title: 'w', date: '2026-10-01', time: '09:00', recurrence: { freq: 'hourly', interval: 5 } });
  assert.deepEqual(slotsOn(it, '2026-10-01'), ['09:00', '14:00', '19:00']);
  assert.deepEqual(slotsOn(it, '2026-10-02'), ['00:00', '05:00', '10:00', '15:00', '20:00']);
  assert.deepEqual(slotsOn(it, '2026-10-03'), ['01:00', '06:00', '11:00', '16:00', '21:00']);
  const every1 = { ...it, recurrence: { freq: 'hourly', interval: 1 } };
  assert.equal(slotsOn(every1, '2026-10-05').length, 24);
  assert.deepEqual(occurrencesBetween(it, '2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  const limited = { ...it, recurrence: { ...it.recurrence, until: '2026-10-02' } };
  assert.deepEqual(occurrencesBetween(limited, '2026-10-01', '2026-10-05'), ['2026-10-01', '2026-10-02']);
});

test('hourly reminders fire at each slot, ids round-trip through alarm names', () => {
  const it = normalizeItem({
    id: 'abc', title: 'w', date: '2026-10-01', time: '09:00',
    recurrence: { freq: 'hourly', interval: 5 }, reminders: [{ offsetMin: 0 }, { offsetMin: 10 }],
  });
  const from = new Date(2026, 9, 1, 8, 0).getTime();
  const to = new Date(2026, 9, 2, 0, 30).getTime();
  const r = remindersBetween([it], from, to);
  assert.deepEqual(r.map((x) => new Date(x.fireAt).toTimeString().slice(0, 5)),
    ['08:50', '09:00', '13:50', '14:00', '18:50', '19:00', '23:50', '00:00']);
  assert.equal(r[1].reminderId, '0@09:00');
  assert.deepEqual(splitReminderId('10@14:00'), { offsetMin: 10, slot: '14:00' });
  assert.deepEqual(splitReminderId('10'), { offsetMin: 10, slot: null });
  assert.deepEqual(parseAlarmName(alarmName(r[2])), { itemId: 'abc', date: '2026-10-01', reminderId: '10@14:00' });
});
