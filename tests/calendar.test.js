import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem } from '../src/lib/model.js';
import { dayRows, filterAll, monthGrid, selectDay, selectionTarget } from '../src/lib/calendar.js';

const NOW = new Date(2026, 9, 1, 10, 0);
let n = 0;
const mk = (o) => normalizeItem({ id: `c${++n}`, title: 't', createdAt: n, ...o });

test('monthGrid: 6 weeks, Monday first, covers the month', () => {
  const g = monthGrid(2026, 9, 1); // October 2026 starts on Thursday
  assert.equal(g.length, 6);
  assert.ok(g.every((w) => w.length === 7));
  assert.equal(g[0][0], '2026-09-28');
  assert.equal(g[0][3], '2026-10-01');
  assert.ok(g.flat().includes('2026-10-31'));
  assert.equal(monthGrid(2026, 9, 0)[0][0], '2026-09-27'); // Sunday first
  assert.equal(monthGrid(2026, 1, 1)[0][0], '2026-01-26'); // Feb 2026 starts on Sunday
});

test('dayRows: spans, repeats, hourly, undated, done state', () => {
  const fair = mk({ title: 'Fair', date: '2026-10-07', endDate: '2026-10-08', type: 'event' });
  const gym = mk({ title: 'Gym', date: '2026-10-01', time: '07:00', recurrence: { freq: 'weekly', weekdays: [4, 5] } });
  const water = mk({ title: 'Water', date: '2026-10-01', time: '09:00', recurrence: { freq: 'hourly', interval: 5 } });
  const gen = mk({ title: 'Someday' });
  const m = dayRows([fair, gym, water, gen], '2026-10-01', '2026-10-09', NOW);
  assert.deepEqual(m.get('2026-10-07').map((r) => r.item.title), ['Fair', 'Water']);
  assert.equal(m.get('2026-10-08').find((r) => r.item.title === 'Fair').span.index, 2);
  assert.deepEqual(m.get('2026-10-02').map((r) => r.item.title), ['Gym', 'Water']); // time order
  assert.equal(m.get('2026-10-03').length, 1); // only Water on Saturday
  assert.ok(![...m.values()].flat().some((r) => r.item.title === 'Someday'));
  const done = { ...gym, completedDates: ['2026-10-02'] };
  assert.equal(dayRows([done], '2026-10-01', '2026-10-02', NOW).get('2026-10-02')[0].done, true);
});

test('dayRows marks only the last day of an unfinished span overdue', () => {
  const past = mk({ title: 'Old trip', date: '2026-09-20', endDate: '2026-09-22' });
  const m = dayRows([past], '2026-09-20', '2026-09-22', NOW);
  assert.deepEqual([...m.values()].map((r) => r[0].overdue), [false, false, true]);
});

test('selectDay: replace, toggle with ctrl, range with shift, click again clears', () => {
  let s = { selected: [], anchor: null };
  s = selectDay(s, '2026-10-05');
  assert.deepEqual(s.selected, ['2026-10-05']);
  s = selectDay(s, '2026-10-07', { ctrl: true });
  assert.deepEqual(s.selected, ['2026-10-05', '2026-10-07']);
  s = selectDay(s, '2026-10-07', { ctrl: true });
  assert.deepEqual(s.selected, ['2026-10-05']);
  s = selectDay({ selected: ['2026-10-05'], anchor: '2026-10-05' }, '2026-10-08', { shift: true });
  assert.deepEqual(s.selected, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  s = selectDay(s, '2026-10-02', { shift: true });
  assert.equal(s.selected.length, 4); // range from the anchor, replaces
  assert.deepEqual(s.selected[0], '2026-10-02');
  s = selectDay({ selected: ['2026-10-05'], anchor: '2026-10-05' }, '2026-10-05');
  assert.deepEqual(s.selected, []);
});

test('selectionTarget: first day, last day only for an unbroken run', () => {
  assert.deepEqual(selectionTarget([]), { date: null, endDate: null });
  assert.deepEqual(selectionTarget(['2026-10-05']), { date: '2026-10-05', endDate: null });
  assert.deepEqual(selectionTarget(['2026-10-07', '2026-10-08']), { date: '2026-10-07', endDate: '2026-10-08' });
  assert.deepEqual(selectionTarget(['2026-10-05', '2026-10-08']), { date: '2026-10-05', endDate: null });
});

test('filterAll: search, status, section, when, range, order', () => {
  const a = mk({ title: 'Dentist', notes: 'Café Rossi nearby', date: '2026-10-03', categoryId: 'work' });
  const b = mk({ title: 'Buy milk' });
  const c = mk({ title: 'Report', date: '2026-09-28', done: true, categoryId: 'study' });
  const d = mk({ title: 'Late one', date: '2026-09-29' });
  const e = mk({ title: 'Run', date: '2026-10-02', recurrence: { freq: 'daily' } });
  const all = [a, b, c, d, e];
  const titles = (f) => filterAll(all, f, NOW).map((i) => i.title);
  assert.deepEqual(titles({}), ['Late one', 'Run', 'Dentist', 'Buy milk']); // open, dated first, undated last
  assert.deepEqual(titles({ status: 'done' }), ['Report']);
  assert.equal(titles({ status: 'all' }).length, 5);
  assert.deepEqual(titles({ query: 'cafe' }), ['Dentist']); // accents and notes
  assert.deepEqual(titles({ query: 'MILK buy' }), ['Buy milk']);
  assert.deepEqual(titles({ category: 'work' }), ['Dentist']);
  assert.deepEqual(titles({ category: 'none' }), ['Late one', 'Run', 'Buy milk']);
  assert.deepEqual(titles({ when: 'overdue' }), ['Late one']);
  assert.deepEqual(titles({ when: 'undated' }), ['Buy milk']);
  assert.deepEqual(titles({ when: 'repeating' }), ['Run']);
  assert.deepEqual(titles({ when: 'week' }), ['Run', 'Dentist']);
  assert.deepEqual(titles({ from: '2026-10-03', to: '2026-10-03' }), ['Run', 'Dentist']);
  assert.deepEqual(titles({ status: 'all', to: '2026-09-28' }), ['Report']);
});
