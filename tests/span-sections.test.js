import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, lastDayOf, normalizeCategory, normalizeItem } from '../src/lib/model.js';
import { createMemoryBackend, createStore } from '../src/lib/store.js';

const base = { id: 'a1', title: 'Job Fair' };

// ---------- multi-day items ----------

test('endDate: valid span is kept, same-day span collapses to null', () => {
  const it = normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-10-08' });
  assert.equal(it.endDate, '2026-10-08');
  assert.equal(lastDayOf(it), '2026-10-08');
  assert.equal(normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-10-07' }).endDate, null);
  assert.equal(lastDayOf(normalizeItem({ ...base, date: '2026-10-07' })), '2026-10-07');
  assert.equal(lastDayOf(normalizeItem(base)), null);
});

test('endDate: rejects reversed, invalid and absurdly long spans', () => {
  assert.throws(() => normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-10-06' }), /before/);
  assert.throws(() => normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-02-30' }), /invalid endDate/);
  assert.throws(() => normalizeItem({ ...base, date: '2026-01-01', endDate: '2027-06-01' }), /too many days/);
  assert.equal(normalizeItem({ ...base, date: '2026-01-01', endDate: '2027-01-02' }).endDate, '2027-01-02'); // 366 days
});

test('endDate is dropped for undated and recurring items', () => {
  assert.equal(normalizeItem({ ...base, endDate: '2026-10-08' }).endDate, null);
  const rec = normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-10-09', recurrence: { freq: 'weekly' } });
  assert.equal(rec.endDate, null);
  assert.ok(rec.recurrence);
});

test('endTime ordering only applies within a single day', () => {
  assert.throws(() => normalizeItem({ ...base, date: '2026-10-07', time: '10:00', endTime: '09:00' }), /after/);
  const span = normalizeItem({ ...base, date: '2026-10-07', endDate: '2026-10-08', time: '18:00', endTime: '12:00' });
  assert.equal(span.endTime, '12:00');
});

let counter = 0;
const fresh = () => createStore(createMemoryBackend(), { now: () => 1000 + counter, newId: () => `id${++counter}`, useLocks: false });

test('moving the start of a multi-day item keeps its length', async () => {
  const s = fresh();
  const a = await s.add({ title: 'Trip', date: '2026-10-07', endDate: '2026-10-09' });
  const b = await s.update(a.id, { date: '2026-10-20' });
  assert.equal(b.endDate, '2026-10-22');
  const c = await s.update(a.id, { date: '2026-11-01', endDate: '2026-11-02' });
  assert.equal(c.endDate, '2026-11-02');
  const d = await s.update(a.id, { endDate: null });
  assert.equal(d.endDate, null);
});

// ---------- sections ----------

test('normalizeCategory validates', () => {
  assert.deepEqual(normalizeCategory({ id: 'c1', name: '  Work ' }), { id: 'c1', name: 'Work', color: 'indigo' });
  assert.deepEqual(normalizeCategory({ id: 'c1', name: 'Uni', color: 'red' }), { id: 'c1', name: 'Uni', color: 'red' });
  assert.throws(() => normalizeCategory({ id: 'c1', name: '  ' }), /required/);
  assert.throws(() => normalizeCategory({ id: 'c1', name: 'x'.repeat(31) }), /too long/);
  assert.throws(() => normalizeCategory({ id: 'c1', name: 'a', color: 'url(javascript:x)' }), /colour/);
  assert.throws(() => normalizeCategory({ id: '../x', name: 'a' }), /invalid id/);
  assert.equal(COLORS.length, 10);
});

test('section CRUD, unique names (case-insensitive), limit', async () => {
  const s = fresh();
  const work = await s.addCategory({ name: 'Work', color: 'blue' });
  await assert.rejects(() => s.addCategory({ name: 'work' }), /already exists/);
  const study = await s.addCategory({ name: 'Study', color: 'green' });
  assert.deepEqual((await s.listCategories()).map((c) => c.name), ['Work', 'Study']);
  await assert.rejects(() => s.updateCategory(study.id, { name: 'WORK' }), /already exists/);
  assert.equal((await s.updateCategory(study.id, { name: 'Uni', color: 'amber' })).name, 'Uni');
  assert.equal((await s.updateCategory(work.id, { name: 'Work' })).name, 'Work'); // renaming to itself is fine
  await assert.rejects(() => s.updateCategory('nope', { name: 'x' }), /not found/);
  for (let i = 0; i < 18; i++) await s.addCategory({ name: `S${i}` });
  await assert.rejects(() => s.addCategory({ name: 'one too many' }), /limit/);
});

test('items can be filed under a section; unknown sections are rejected', async () => {
  const s = fresh();
  const work = await s.addCategory({ name: 'Work' });
  const a = await s.add({ title: 'Report', categoryId: work.id });
  assert.equal(a.categoryId, work.id);
  await assert.rejects(() => s.add({ title: 'x', categoryId: 'ghost' }), /unknown section/);
  await assert.rejects(() => s.update(a.id, { categoryId: 'ghost' }), /unknown section/);
  const b = await s.update(a.id, { categoryId: null });
  assert.equal(b.categoryId, null);
});

test('deleting a section keeps its items and unsections them', async () => {
  const s = fresh();
  const work = await s.addCategory({ name: 'Work' });
  const other = await s.addCategory({ name: 'Other' });
  const a = await s.add({ title: 'a', categoryId: work.id });
  const b = await s.add({ title: 'b', categoryId: other.id });
  assert.deepEqual(await s.removeCategory(work.id), { removed: true, itemsCleared: 1 });
  assert.equal((await s.get(a.id)).categoryId, null);
  assert.equal((await s.get(b.id)).categoryId, other.id);
  assert.deepEqual(await s.removeCategory(work.id), { removed: false, itemsCleared: 0 });
});

test('getState returns items, sections and settings together', async () => {
  const s = fresh();
  await s.addCategory({ name: 'Work' });
  await s.add({ title: 'a' });
  const st = await s.getState();
  assert.equal(st.items.length, 1);
  assert.equal(st.categories.length, 1);
  assert.equal(st.settings.snoozeMin, 10);
});

test('old data without sections still loads', async () => {
  const backend = createMemoryBackend();
  await backend.set('dayline:v1', { version: 1, items: [], settings: { allDayReminderTime: '09:00' } });
  const s = createStore(backend, { useLocks: false, newId: () => 'z1' });
  assert.deepEqual(await s.listCategories(), []);
  assert.equal((await s.getSettings()).snoozeMin, 10);
});

test('export/import round-trips sections and multi-day items', async () => {
  const a = fresh();
  const work = await a.addCategory({ name: 'Work', color: 'red' });
  await a.add({ title: 'Fair', date: '2026-10-07', endDate: '2026-10-08', categoryId: work.id });
  const json = await a.exportJson();
  const b = fresh();
  const res = await b.importJson(json);
  assert.equal(res.categoriesAdded, 1);
  assert.deepEqual(await b.listCategories(), await a.listCategories());
  assert.deepEqual(await b.list(), await a.list());
  const again = await b.importJson(json); // importing twice adds nothing
  assert.deepEqual([again.added, again.categoriesAdded, again.unchanged], [0, 0, 1]);
  assert.equal((await b.listCategories()).length, 1);
});

test('merge import maps a same-named section onto the existing one', async () => {
  const src = fresh();
  const w1 = await src.addCategory({ name: 'Work' });
  await src.add({ title: 'imported', categoryId: w1.id });
  const json = await src.exportJson();

  const dst = createStore(createMemoryBackend(), { newId: (() => { let n = 0; return () => `d${++n}`; })(), useLocks: false });
  const w2 = await dst.addCategory({ name: 'work' }); // same name, different id and case
  const res = await dst.importJson(json);
  assert.equal(res.categoriesAdded, 0);
  assert.equal((await dst.listCategories()).length, 1);
  assert.equal((await dst.list())[0].categoryId, w2.id);
});

test('import drops references to sections that are not in the file', async () => {
  const s = fresh();
  const doc = { app: 'dayline', formatVersion: 1, items: [{ id: 'q1', title: 'x', categoryId: 'ghost' }], categories: [{ id: 'bad', name: '', color: 'red' }] };
  const res = await s.importJson(JSON.stringify(doc));
  assert.equal((await s.get('q1')).categoryId, null);
  assert.equal(res.errors.some((e) => e.startsWith('section 0')), true);
});

test('replace import swaps sections too', async () => {
  const s = fresh();
  await s.addCategory({ name: 'Old' });
  const other = fresh();
  const n = await other.addCategory({ name: 'New' });
  await other.add({ title: 't', categoryId: n.id });
  await s.importJson(await other.exportJson(), { mode: 'replace' });
  assert.deepEqual((await s.listCategories()).map((c) => c.name), ['New']);
  assert.equal((await s.list())[0].categoryId, n.id);
});
