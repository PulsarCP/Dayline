import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, combine, diffDays, isValidDateStr, isValidTimeStr, parseDateStr, toDateStr, weekdayOf,
} from '../src/lib/dates.js';
import { nextOccurrence, normalizeRecurrence, occurrencesBetween } from '../src/lib/recurrence.js';

const item = (date, recurrence = null) => ({ date, recurrence });

test('date strings round-trip and reject impossible dates', () => {
  assert.equal(toDateStr(parseDateStr('2026-09-30')), '2026-09-30');
  assert.equal(isValidDateStr('2026-02-30'), false);
  assert.equal(isValidDateStr('2028-02-29'), true);
  assert.equal(isValidDateStr('2026-13-01'), false);
  assert.equal(isValidDateStr('26-01-01'), false);
  assert.equal(isValidDateStr(20260930), false);
  assert.equal(isValidTimeStr('23:59'), true);
  assert.equal(isValidTimeStr('24:00'), false);
  assert.equal(isValidTimeStr('7:00'), false);
});

test('addDays / diffDays / weekdayOf cross month, year and DST boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-03-28', '2026-03-30'), 2); // Europe DST switch 29 Mar 2026
  assert.equal(diffDays('2026-10-24', '2026-10-26'), 2); // Europe DST end 25 Oct 2026
  assert.equal(weekdayOf('2026-09-30'), 3); // Wednesday
});

test('addMonths clamps the day', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
});

test('combine builds a local date-time', () => {
  const d = combine('2026-09-30', '15:45');
  assert.equal([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()].join(','), '2026,8,30,15,45');
});

test('one-off items: only their own date', () => {
  assert.deepEqual(occurrencesBetween(item('2026-10-05'), '2026-10-01', '2026-10-31'), ['2026-10-05']);
  assert.deepEqual(occurrencesBetween(item('2026-10-05'), '2026-10-06', '2026-10-31'), []);
  assert.deepEqual(occurrencesBetween(item(null), '2026-10-01', '2026-10-31'), []);
});

test('daily with interval, window starting mid-series', () => {
  const it = item('2026-10-01', { freq: 'daily', interval: 3 });
  assert.deepEqual(occurrencesBetween(it, '2026-10-05', '2026-10-13'), ['2026-10-07', '2026-10-10', '2026-10-13']);
});

test('weekly: default weekday, multiple weekdays, interval, until', () => {
  const dflt = item('2026-10-07', { freq: 'weekly', interval: 1 }); // Wed
  assert.deepEqual(occurrencesBetween(dflt, '2026-10-01', '2026-10-21'), ['2026-10-07', '2026-10-14', '2026-10-21']);

  const multi = item('2026-10-05', { freq: 'weekly', interval: 1, weekdays: [1, 3, 5] }); // Mon start
  assert.deepEqual(occurrencesBetween(multi, '2026-10-05', '2026-10-11'), ['2026-10-05', '2026-10-07', '2026-10-09']);

  const everyOther = item('2026-10-05', { freq: 'weekly', interval: 2, weekdays: [1] });
  assert.deepEqual(occurrencesBetween(everyOther, '2026-10-01', '2026-11-10'), ['2026-10-05', '2026-10-19', '2026-11-02']);

  const bounded = item('2026-10-05', { freq: 'weekly', interval: 1, weekdays: [1], until: '2026-10-12' });
  assert.deepEqual(occurrencesBetween(bounded, '2026-10-01', '2026-12-31'), ['2026-10-05', '2026-10-12']);
});

test('weekly: weekdays earlier in the start week are not occurrences', () => {
  const it = item('2026-10-07', { freq: 'weekly', interval: 1, weekdays: [1, 3] }); // starts Wed
  assert.deepEqual(occurrencesBetween(it, '2026-10-05', '2026-10-14'), ['2026-10-07', '2026-10-12', '2026-10-14']);
});

test('monthly: clamps to month end and keeps the original day afterwards', () => {
  const it = item('2026-01-31', { freq: 'monthly', interval: 1 });
  assert.deepEqual(occurrencesBetween(it, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  const q = item('2026-01-15', { freq: 'monthly', interval: 3 });
  assert.deepEqual(occurrencesBetween(q, '2026-02-01', '2026-12-31'), ['2026-04-15', '2026-07-15', '2026-10-15']);
});

test('window is capped so a huge range cannot hang', () => {
  const it = item('2026-01-01', { freq: 'daily', interval: 1 });
  const out = occurrencesBetween(it, '2026-01-01', '2999-12-31');
  assert.equal(out.length, 801);
});

test('nextOccurrence', () => {
  const it = item('2026-10-05', { freq: 'weekly', interval: 1, weekdays: [1] });
  assert.equal(nextOccurrence(it, '2026-10-05'), '2026-10-12');
  assert.equal(nextOccurrence(it, '2026-10-05', { includeAfter: true }), '2026-10-05');
  assert.equal(nextOccurrence(item('2026-10-05'), '2026-10-05'), null);
});

test('normalizeRecurrence validates', () => {
  assert.equal(normalizeRecurrence(null), null);
  assert.deepEqual(normalizeRecurrence({ freq: 'weekly', weekdays: [3, 1, 3] }), { freq: 'weekly', interval: 1, weekdays: [1, 3] });
  assert.throws(() => normalizeRecurrence({ freq: 'hourly' }));
  assert.throws(() => normalizeRecurrence({ freq: 'daily', interval: 0 }));
  assert.throws(() => normalizeRecurrence({ freq: 'daily', interval: 1.5 }));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', weekdays: [7] }));
  assert.throws(() => normalizeRecurrence({ freq: 'daily', until: 'nope' }));
});
