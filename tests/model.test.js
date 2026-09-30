import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, isDoneOn, normalizeSettings } from '../src/lib/model.js';

const base = { id: 'a1', title: 'Test' };

test('minimal item gets sane defaults', () => {
  const it = normalizeItem(base, 1000);
  assert.deepEqual(it, {
    id: 'a1', title: 'Test', notes: '', type: 'task', date: null, time: null, endTime: null,
    recurrence: null, reminders: [], done: false, doneAt: null, completedDates: [],
    createdAt: 1000, updatedAt: 1000,
  });
});

test('unknown and hostile fields are dropped', () => {
  const it = normalizeItem({ ...base, evil: '<img onerror=x>', __proto__: { polluted: true }, constructor: 'x' });
  assert.equal('evil' in it, false);
  assert.equal(it.polluted, undefined);
});

test('title is cleaned and required', () => {
  assert.equal(normalizeItem({ ...base, title: '  a\n\tb  ' }).title, 'a b');
  assert.throws(() => normalizeItem({ ...base, title: '   ' }), /title is required/);
  assert.throws(() => normalizeItem({ ...base, title: 'x'.repeat(201) }), /too long/);
  assert.throws(() => normalizeItem({ ...base, title: 5 }), TypeError);
});

test('ids must be simple strings', () => {
  for (const id of ['', 'a b', '../x', 'x'.repeat(65), 5, null]) {
    assert.throws(() => normalizeItem({ ...base, id }), /invalid id/);
  }
});

test('notes keep newlines but lose control characters', () => {
  assert.equal(normalizeItem({ ...base, notes: 'a\nb\u0000c' }).notes, 'a\nbc');
  assert.throws(() => normalizeItem({ ...base, notes: 'x'.repeat(2001) }), /too long/);
});

test('undated items lose time, endTime and recurrence but keep reminders', () => {
  const it = normalizeItem({
    ...base, time: '10:00', endTime: '11:00', recurrence: { freq: 'daily' }, reminders: [{ offsetMin: 10 }],
  });
  assert.equal(it.time, null);
  assert.equal(it.endTime, null);
  assert.equal(it.recurrence, null);
  assert.deepEqual(it.reminders, [{ offsetMin: 10 }]);
});

test('time validation and endTime ordering', () => {
  assert.throws(() => normalizeItem({ ...base, date: '2026-10-01', time: '25:00' }), /invalid time/);
  assert.throws(() => normalizeItem({ ...base, date: '2026-10-01', time: '10:00', endTime: '09:00' }), /after/);
  assert.equal(normalizeItem({ ...base, date: '2026-10-01', time: '10:00', endTime: '11:30' }).endTime, '11:30');
});

test('reminders are validated, deduplicated and sorted', () => {
  const it = normalizeItem({ ...base, date: '2026-10-01', reminders: [{ offsetMin: 60 }, 10, { offsetMin: 10 }, { offsetMin: 0 }] });
  assert.deepEqual(it.reminders, [{ offsetMin: 0 }, { offsetMin: 10 }, { offsetMin: 60 }]);
  assert.throws(() => normalizeItem({ ...base, reminders: [{ offsetMin: -1 }] }));
  assert.throws(() => normalizeItem({ ...base, reminders: [{ offsetMin: 1.5 }] }));
  assert.throws(() => normalizeItem({ ...base, reminders: [{ offsetMin: 999999 }] }));
  assert.throws(() => normalizeItem({ ...base, reminders: Array.from({ length: 11 }, (_, i) => i) }), /too many/);
});

test('completedDates only survive on recurring items, cleaned', () => {
  const rec = normalizeItem({
    ...base, date: '2026-10-01', recurrence: { freq: 'daily' }, completedDates: ['2026-10-03', 'bad', '2026-10-02', '2026-10-03'],
  });
  assert.deepEqual(rec.completedDates, ['2026-10-02', '2026-10-03']);
  const one = normalizeItem({ ...base, date: '2026-10-01', completedDates: ['2026-10-02'] });
  assert.deepEqual(one.completedDates, []);
});

test('isDoneOn: one-off vs per-occurrence', () => {
  const one = normalizeItem({ ...base, done: true });
  assert.equal(isDoneOn(one, '2026-10-01'), true);
  const rec = normalizeItem({ ...base, date: '2026-10-01', recurrence: { freq: 'daily' }, completedDates: ['2026-10-02'] });
  assert.equal(isDoneOn(rec, '2026-10-02'), true);
  assert.equal(isDoneOn(rec, '2026-10-03'), false);
});

test('settings fall back to defaults', () => {
  assert.deepEqual(normalizeSettings({ allDayReminderTime: '08:30' }), { allDayReminderTime: '08:30', defaultReminderMin: 10 });
  assert.deepEqual(normalizeSettings({ allDayReminderTime: 'x' }), { allDayReminderTime: '09:00', defaultReminderMin: 10 });
  assert.deepEqual(normalizeSettings(undefined), { allDayReminderTime: '09:00', defaultReminderMin: 10 });
});

test('defaultReminderMin: null means none, invalid values fall back to 10', () => {
  assert.equal(normalizeSettings({ defaultReminderMin: null }).defaultReminderMin, null);
  assert.equal(normalizeSettings({ defaultReminderMin: 0 }).defaultReminderMin, 0);
  assert.equal(normalizeSettings({ defaultReminderMin: 60 }).defaultReminderMin, 60);
  for (const bad of [-1, 1.5, '10', 99999999, NaN]) {
    assert.equal(normalizeSettings({ defaultReminderMin: bad }).defaultReminderMin, 10);
  }
});
