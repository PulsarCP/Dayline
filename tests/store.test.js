import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend, createStore, LOCK_NAME } from '../src/lib/store.js';

let clock = 1_000_000;
let counter = 0;
const fresh = (backend = createMemoryBackend()) =>
  createStore(backend, { now: () => ++clock, newId: () => `id${++counter}`, useLocks: false });

test('add / get / list / remove', async () => {
  const s = fresh();
  const a = await s.add({ title: 'Buy milk' });
  assert.equal(a.done, false);
  assert.equal(a.date, null);
  assert.deepEqual((await s.list()).map((i) => i.title), ['Buy milk']);
  assert.equal((await s.get(a.id)).title, 'Buy milk');
  assert.equal(await s.get('nope'), null);
  assert.equal(await s.remove(a.id), true);
  assert.equal(await s.remove(a.id), false);
  assert.deepEqual(await s.list(), []);
});

test('add ignores caller-supplied id / done / completion fields', async () => {
  const s = fresh();
  const a = await s.add({ title: 'x', id: 'hacked', done: true, doneAt: 5, completedDates: ['2026-01-01'] });
  assert.notEqual(a.id, 'hacked');
  assert.equal(a.done, false);
  assert.equal(a.doneAt, null);
});

test('add rejects invalid input and stores nothing', async () => {
  const s = fresh();
  await assert.rejects(() => s.add({ title: '' }));
  await assert.rejects(() => s.add({ title: 'x', date: '2026-02-30' }));
  assert.deepEqual(await s.list(), []);
});

test('returned objects are copies', async () => {
  const s = fresh();
  const a = await s.add({ title: 'x' });
  a.title = 'mutated';
  (await s.list())[0].title = 'mutated';
  assert.equal((await s.get(a.id)).title, 'x');
});

test('update patches allowed fields only and bumps updatedAt', async () => {
  const s = fresh();
  const a = await s.add({ title: 'x', date: '2026-10-01' });
  const b = await s.update(a.id, { title: 'y', time: '09:00', id: 'evil', done: true, createdAt: 1 });
  assert.equal(b.title, 'y');
  assert.equal(b.time, '09:00');
  assert.equal(b.id, a.id);
  assert.equal(b.done, false);
  assert.equal(b.createdAt, a.createdAt);
  assert.ok(b.updatedAt > a.updatedAt);
  await assert.rejects(() => s.update('missing', { title: 'z' }), /not found/);
  await assert.rejects(() => s.update(a.id, { time: '99:99' }));
  assert.equal((await s.get(a.id)).time, '09:00'); // failed update changed nothing
});

test('setDone: one-off and undated items', async () => {
  const s = fresh();
  const a = await s.add({ title: 'general task' });
  const done = await s.setDone(a.id, true);
  assert.equal(done.done, true);
  assert.ok(done.doneAt > 0);
  const undone = await s.setDone(a.id, false);
  assert.equal(undone.done, false);
  assert.equal(undone.doneAt, null);
});

test('setDone: recurring items are completed per occurrence', async () => {
  const s = fresh();
  const a = await s.add({ title: 'meds', date: '2026-10-01', recurrence: { freq: 'daily' } });
  await assert.rejects(() => s.setDone(a.id, true), /occurrenceDate/);
  await s.setDone(a.id, true, '2026-10-02');
  await s.setDone(a.id, true, '2026-10-03');
  let cur = await s.get(a.id);
  assert.deepEqual(cur.completedDates, ['2026-10-02', '2026-10-03']);
  assert.equal(cur.done, false);
  await s.setDone(a.id, false, '2026-10-02');
  cur = await s.get(a.id);
  assert.deepEqual(cur.completedDates, ['2026-10-03']);
});

test('removing the recurrence clears per-occurrence completions', async () => {
  const s = fresh();
  const a = await s.add({ title: 'x', date: '2026-10-01', recurrence: { freq: 'daily' } });
  await s.setDone(a.id, true, '2026-10-02');
  const b = await s.update(a.id, { recurrence: null });
  assert.deepEqual(b.completedDates, []);
});

test('concurrent adds are all kept (no lost updates) even with a slow backend', async () => {
  const s = fresh(createMemoryBackend(2));
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.add({ title: `t${i}` })));
  assert.equal((await s.list()).length, 40);
});

test('a failing mutation does not block later ones', async () => {
  const s = fresh();
  await assert.rejects(() => s.update('missing', { title: 'x' }));
  await s.add({ title: 'still works' });
  assert.equal((await s.list()).length, 1);
});

test('navigator.locks path (only where the runtime has it)', async (t) => {
  if (!globalThis.navigator?.locks) {
    t.skip('navigator.locks not available in this Node version');
    return;
  }
  const s = createStore(createMemoryBackend(1), { now: () => ++clock, newId: () => `id${++counter}`, useLocks: true });
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.add({ title: `t${i}` })));
  assert.equal((await s.list()).length, 20);
  assert.equal(typeof LOCK_NAME, 'string');
});

test('settings', async () => {
  const s = fresh();
  assert.deepEqual(await s.getSettings(), { allDayReminderTime: '09:00', defaultReminderMin: 10, snoozeMin: 10 });
  assert.deepEqual(await s.updateSettings({ allDayReminderTime: '08:15' }), { allDayReminderTime: '08:15', defaultReminderMin: 10, snoozeMin: 10 });
  assert.deepEqual(await s.updateSettings({ defaultReminderMin: null, snoozeMin: 30 }), { allDayReminderTime: '08:15', defaultReminderMin: null, snoozeMin: 30 });
  assert.deepEqual(await s.updateSettings({ allDayReminderTime: 'garbage', snoozeMin: 7 }), { allDayReminderTime: '09:00', defaultReminderMin: null, snoozeMin: 10 });
});

test('export -> import round trip into an empty store', async () => {
  const a = fresh();
  await a.add({ title: 'one', date: '2026-10-01', time: '09:00', reminders: [{ offsetMin: 10 }] });
  await a.add({ title: 'two' });
  const json = await a.exportJson();
  const b = fresh();
  const res = await b.importJson(json);
  assert.equal(res.added, 2);
  assert.deepEqual(await b.list(), await a.list());
});

test('merge import: newer wins, older is kept, invalid is skipped', async () => {
  const s = fresh();
  const a = await s.add({ title: 'original' });
  const doc = JSON.parse(await s.exportJson());
  doc.items[0].title = 'edited elsewhere';
  doc.items[0].updatedAt = a.updatedAt + 100;
  doc.items.push({ id: 'bad id', title: 'x' }, { id: 'ok1', title: 'new one' });

  const res = await s.importJson(JSON.stringify(doc));
  assert.equal(res.updated, 1);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.errors.length, 1);
  assert.equal((await s.get(a.id)).title, 'edited elsewhere');

  doc.items[0].title = 'stale copy';
  doc.items[0].updatedAt = 1;
  const again = await s.importJson(JSON.stringify(doc));
  assert.equal(again.unchanged, 2);
  assert.equal((await s.get(a.id)).title, 'edited elsewhere');
});

test('import rejects junk without touching data', async () => {
  const s = fresh();
  await s.add({ title: 'precious' });
  await assert.rejects(() => s.importJson('not json'), SyntaxError);
  await assert.rejects(() => s.importJson('{"app":"other"}'), /not a Dayline/);
  await assert.rejects(() => s.importJson(JSON.stringify({ app: 'dayline', formatVersion: 2, items: [] })), /not a Dayline/);
  await assert.rejects(() => s.importJson('x'.repeat(5_000_001)), /too large/);
  await assert.rejects(() => s.importJson(JSON.stringify({ app: 'dayline', formatVersion: 1, items: [{ id: '!', title: 1 }] }), { mode: 'replace' }), /no valid items/);
  assert.equal((await s.list()).length, 1);
});

test('replace import swaps the data set', async () => {
  const s = fresh();
  await s.add({ title: 'old' });
  const other = fresh();
  await other.add({ title: 'new' });
  await s.importJson(await other.exportJson(), { mode: 'replace' });
  assert.deepEqual((await s.list()).map((i) => i.title), ['new']);
});

test('sanitisation applies to imported items too', async () => {
  const s = fresh();
  const doc = { app: 'dayline', formatVersion: 1, items: [{ id: 'z1', title: 'ok', evil: 'x', reminders: [{ offsetMin: 5, extra: 1 }] }] };
  await s.importJson(JSON.stringify(doc));
  const it = await s.get('z1');
  assert.equal('evil' in it, false);
  assert.deepEqual(it.reminders, [{ offsetMin: 5 }]);
});

test('chrome backend adapter talks to chrome.storage.local-shaped areas', async () => {
  const { createChromeBackend } = await import('../src/lib/store.js');
  const mem = {};
  const area = {
    async get(key) { return key in mem ? { [key]: structuredClone(mem[key]) } : {}; },
    async set(obj) { Object.assign(mem, structuredClone(obj)); },
  };
  const s = createStore(createChromeBackend(area), { now: () => ++clock, newId: () => `id${++counter}`, useLocks: false });
  await s.add({ title: 'via chrome area' });
  assert.equal((await s.list())[0].title, 'via chrome area');
  assert.ok('dayline:v1' in mem);
  assert.throws(() => createChromeBackend(undefined), /not available/);
});
