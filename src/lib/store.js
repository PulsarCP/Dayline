// Storage layer. All data lives in chrome.storage.local under one key; nothing
// leaves the machine. The backend is injectable so the same code runs in Node tests.
//
// Writes are serialised (read-modify-write under a lock). navigator.locks is used
// when available because it also covers the popup, options tab and service worker,
// which are separate JS contexts; otherwise an in-process promise queue is used.

import { addDays, diffDays, isValidDateStr, timeStrOf, toDateStr } from './dates.js';
import {
  DEFAULT_SETTINGS, LIMITS, normalizeCategory, normalizeItem, normalizeSettings,
} from './model.js';

export const STORAGE_KEY = 'dayline:v1';
export const LOCK_NAME = 'dayline-store';
export const EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_CHARS = 5_000_000;

const PATCHABLE = [
  'title', 'notes', 'type', 'date', 'endDate', 'time', 'endTime', 'recurrence', 'categoryId', 'reminders',
  'checkable', 'showOnCalendar',
];

export function createChromeBackend(area = globalThis.chrome?.storage?.local) {
  if (!area) throw new Error('chrome.storage.local is not available');
  return {
    async get(key) {
      const result = await area.get(key);
      return result[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
  };
}

export function createMemoryBackend(delayMs = 0) {
  const data = new Map();
  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  return {
    async get(key) {
      await wait();
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    async set(key, value) {
      await wait();
      data.set(key, structuredClone(value));
    },
  };
}

const emptyState = () => ({
  version: 1, items: [], categories: [], settings: { ...DEFAULT_SETTINGS },
});

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

export function createStore(backend, opts = {}) {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const useLocks = opts.useLocks ?? Boolean(globalThis.navigator?.locks);
  let chain = Promise.resolve();

  function withLock(fn) {
    if (useLocks) return globalThis.navigator.locks.request(LOCK_NAME, fn);
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function load() {
    const raw = await backend.get(STORAGE_KEY);
    if (!raw || !Array.isArray(raw.items)) return emptyState();
    return {
      version: 1,
      items: raw.items,
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      settings: normalizeSettings(raw.settings),
    };
  }

  const save = (state) => backend.set(STORAGE_KEY, state);

  /** Load, apply fn(state), save. Nothing is saved if fn throws. */
  const mutate = (fn) =>
    withLock(async () => {
      const state = await load();
      const result = await fn(state);
      await save(state);
      return result;
    });

  const findIndex = (state, id) => {
    const i = state.items.findIndex((it) => it.id === id);
    if (i < 0) throw new Error(`item not found: ${id}`);
    return i;
  };

  const assertCategoryExists = (state, id) => {
    if (id != null && !state.categories.some((c) => c.id === id)) {
      throw new RangeError('unknown section');
    }
  };

  const assertNameFree = (state, name, exceptId) => {
    if (state.categories.some((c) => c.id !== exceptId && sameName(c.name, name))) {
      throw new RangeError('a section with that name already exists');
    }
  };

  return {
    async list() {
      return structuredClone((await load()).items);
    },

    /** Items, sections and settings from one consistent read. */
    async getState() {
      const { items, categories, settings } = await load();
      return structuredClone({ items, categories, settings });
    },

    async get(id) {
      const item = (await load()).items.find((it) => it.id === id);
      return item ? structuredClone(item) : null;
    },

    add(input) {
      return mutate((state) => {
        if (state.items.length >= LIMITS.items) throw new RangeError('item limit reached');
        assertCategoryExists(state, input.categoryId);
        const t = now();
        const item = normalizeItem(
          {
            ...input,
            id: newId(),
            done: false,
            doneAt: null,
            completedDates: [],
            createdAt: t,
            updatedAt: t,
          },
          t,
        );
        state.items.push(item);
        return structuredClone(item);
      });
    },

    update(id, patch) {
      return mutate((state) => {
        const i = findIndex(state, id);
        const old = state.items[i];
        const merged = { ...old };
        for (const key of PATCHABLE) if (key in patch) merged[key] = patch[key];
        // Moving a multi-day item's start keeps its length unless the caller sets the end too.
        if ('date' in patch && !('endDate' in patch) && old.date && old.endDate && patch.date
          && isValidDateStr(patch.date)) {
          merged.endDate = addDays(patch.date, diffDays(old.date, old.endDate));
        }
        assertCategoryExists(state, merged.categoryId);
        const t = now();
        merged.updatedAt = t;
        state.items[i] = normalizeItem(merged, t);
        return structuredClone(state.items[i]);
      });
    },

    /** Recurring items need `occurrenceDate`; one-off items ignore it. */
    setDone(id, done, occurrenceDate) {
      return mutate((state) => {
        const i = findIndex(state, id);
        const item = { ...state.items[i] };
        const t = now();
        if (item.recurrence) {
          const key = String(occurrenceDate ?? '');
          const okKey = isValidDateStr(key)
            || (item.recurrence.freq === 'hourly' && /^\d{4}-\d{2}-\d{2}@\d{2}:\d{2}$/.test(key));
          if (!okKey) throw new TypeError('occurrenceDate required');
          const set = new Set(item.completedDates);
          if (done) set.add(key);
          else set.delete(key);
          item.completedDates = [...set];
        } else {
          item.done = Boolean(done);
          item.doneAt = item.done ? t : null;
        }
        item.updatedAt = t;
        state.items[i] = normalizeItem(item, t);
        return structuredClone(state.items[i]);
      });
    },

    /**
     * Hourly items: "I just did it". Re-anchors the series at the current minute, so the next
     * slot is one interval from now, and ticks the current slot.
     */
    restartHourly(id) {
      return mutate((state) => {
        const i = findIndex(state, id);
        const item = { ...state.items[i] };
        if (item.recurrence?.freq !== 'hourly') throw new TypeError('not an hourly item');
        const t = now();
        const d = new Date(t);
        const date = toDateStr(d);
        const time = timeStrOf(d);
        item.date = date;
        item.time = time;
        item.endTime = null;
        item.completedDates = [`${date}@${time}`];
        item.updatedAt = t;
        state.items[i] = normalizeItem(item, t);
        return structuredClone(state.items[i]);
      });
    },

    remove(id) {
      return mutate((state) => {
        const before = state.items.length;
        state.items = state.items.filter((it) => it.id !== id);
        return state.items.length < before;
      });
    },

    // ---------- sections ----------

    async listCategories() {
      return structuredClone((await load()).categories);
    },

    addCategory({ name, color }) {
      return mutate((state) => {
        if (state.categories.length >= LIMITS.categories) throw new RangeError('section limit reached');
        const cat = normalizeCategory({ id: newId(), name, color });
        assertNameFree(state, cat.name);
        state.categories.push(cat);
        return { ...cat };
      });
    },

    updateCategory(id, patch) {
      return mutate((state) => {
        const i = state.categories.findIndex((c) => c.id === id);
        if (i < 0) throw new Error(`section not found: ${id}`);
        const cat = normalizeCategory({
          id,
          name: 'name' in patch ? patch.name : state.categories[i].name,
          color: 'color' in patch ? patch.color : state.categories[i].color,
        });
        assertNameFree(state, cat.name, id);
        state.categories[i] = cat;
        return { ...cat };
      });
    },

    /** Deleting a section keeps its items; they just become unsectioned. */
    removeCategory(id) {
      return mutate((state) => {
        const before = state.categories.length;
        state.categories = state.categories.filter((c) => c.id !== id);
        let cleared = 0;
        for (const it of state.items) {
          if (it.categoryId === id) {
            it.categoryId = null;
            cleared++;
          }
        }
        return { removed: state.categories.length < before, itemsCleared: cleared };
      });
    },

    // ---------- settings ----------

    async getSettings() {
      return { ...(await load()).settings };
    },

    updateSettings(patch) {
      return mutate((state) => {
        state.settings = normalizeSettings({ ...state.settings, ...patch });
        return { ...state.settings };
      });
    },

    // ---------- backup ----------

    async exportJson() {
      const { items, categories, settings } = await load();
      return JSON.stringify(
        {
          app: 'dayline',
          formatVersion: EXPORT_FORMAT_VERSION,
          exportedAt: new Date(now()).toISOString(),
          settings,
          categories,
          items,
        },
        null,
        2,
      );
    },

    /**
     * Import a Dayline export. Every item and section is re-validated; invalid ones are skipped.
     * mode 'merge': add new ids, replace existing ones only if the file's copy is newer.
     *   Sections match by id, then by name, so importing the same backup twice adds nothing.
     * mode 'replace': swap everything for the file's valid data (refuses if none is valid).
     * @returns {{added:number,updated:number,unchanged:number,skipped:number,
     *            categoriesAdded:number,errors:string[]}}
     */
    async importJson(text, { mode = 'merge' } = {}) {
      if (mode !== 'merge' && mode !== 'replace') throw new RangeError('invalid import mode');
      if (typeof text !== 'string' || text.length > MAX_IMPORT_CHARS) {
        throw new RangeError('import file too large');
      }
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new SyntaxError('import file is not valid JSON');
      }
      if (
        !doc || doc.app !== 'dayline' || doc.formatVersion !== EXPORT_FORMAT_VERSION
        || !Array.isArray(doc.items)
      ) {
        throw new TypeError('not a Dayline export file');
      }
      if (doc.items.length > LIMITS.items) throw new RangeError('too many items in file');
      const rawCats = Array.isArray(doc.categories) ? doc.categories.slice(0, 200) : [];

      const errors = [];
      const note = (msg) => { if (errors.length < 5) errors.push(msg); };

      const incomingCats = [];
      for (const [n, raw] of rawCats.entries()) {
        try {
          incomingCats.push(normalizeCategory(raw));
        } catch (e) {
          note(`section ${n}: ${e.message}`);
        }
      }

      const incoming = new Map();
      let skipped = 0;
      for (const [n, raw] of doc.items.entries()) {
        try {
          const item = normalizeItem(raw, now());
          // An item without its own updatedAt must never beat a stored copy, otherwise
          // re-importing the same hand-edited file would overwrite newer local edits.
          incoming.set(item.id, { item, stamp: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0 });
        } catch (e) {
          skipped++;
          note(`item ${n}: ${e.message}`);
        }
      }
      if (mode === 'replace' && doc.items.length > 0 && incoming.size === 0) {
        throw new Error('no valid items in file; nothing was replaced');
      }

      return mutate((state) => {
        const summary = {
          added: 0, updated: 0, unchanged: 0, skipped, categoriesAdded: 0, errors,
        };

        // Decide the final section list and how file section ids map onto it.
        const idMap = new Map();
        let cats;
        if (mode === 'replace') {
          cats = [];
        } else {
          cats = [...state.categories];
        }
        for (const c of incomingCats) {
          const sameId = cats.find((x) => x.id === c.id);
          const byName = cats.find((x) => sameName(x.name, c.name));
          if (sameId) idMap.set(c.id, sameId.id);
          else if (byName) idMap.set(c.id, byName.id);
          else if (cats.length < LIMITS.categories) {
            cats.push(c);
            idMap.set(c.id, c.id);
            summary.categoriesAdded++;
          } else {
            note(`section "${c.name}" skipped: section limit reached`);
          }
        }
        const remap = (item) => {
          if (item.categoryId == null) return item;
          return { ...item, categoryId: idMap.get(item.categoryId) ?? null };
        };

        if (mode === 'replace') {
          state.categories = cats;
          state.items = [...incoming.values()].map((e) => remap(e.item));
          summary.added = incoming.size;
          if (doc.settings) state.settings = normalizeSettings(doc.settings);
          return summary;
        }

        state.categories = cats;
        const byId = new Map(state.items.map((it) => [it.id, it]));
        for (const { item, stamp } of incoming.values()) {
          const existing = byId.get(item.id);
          if (!existing) {
            if (byId.size >= LIMITS.items) throw new RangeError('item limit reached');
            byId.set(item.id, remap(item));
            summary.added++;
          } else if (stamp > existing.updatedAt) {
            byId.set(item.id, remap(item));
            summary.updated++;
          } else {
            summary.unchanged++;
          }
        }
        state.items = [...byId.values()];
        return summary;
      });
    },
  };
}
