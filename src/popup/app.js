// Popup UI. mountPopup() takes a Document and a store, so the same code runs in the
// extension popup and in tests. All text is inserted with textContent / text nodes,
// never innerHTML: titles come from the user and from imported files.

import { toDateStr } from '../lib/dates.js';
import { COLORS } from '../lib/model.js';
import { parseQuickAdd } from '../lib/parser.js';
import {
  buildViews, categoryOf, formatDate, formatDay, formatRange, formatWhen, offsetLabel, remindersFor,
  remindersSummary, repeatLabel, REMINDER_CHOICES, spanLabel,
} from '../lib/views.js';
import { createH, createIcon } from '../ui/dom.js';
import { createItemForm } from '../ui/item-form.js';

const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'general', label: 'General' },
];

const EMPTY = {
  today: ['Nothing due today', 'Type above to add something, like “call mom tomorrow 6pm”.'],
  upcoming: ['Nothing coming up', 'Anything with a date in the next week shows here.'],
  general: ['No general items', 'Things without a date live here. Add one without a day or time.'],
};

const normTag = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');

export function mountPopup(doc, store, {
  now = () => new Date(), animationMs = 450, openOptions = () => {},
} = {}) {
  const win = doc.defaultView;
  const h = createH(doc);
  const icon = createIcon(doc);
  const $ = (id) => doc.getElementById(id);
  const el = {
    main: $('main-view'),
    dateLabel: $('date-label'),
    options: $('open-options'),
    form: $('add-form'),
    input: $('add-input'),
    addBtn: $('add-btn'),
    preview: $('preview'),
    category: $('add-category'),
    reminder: $('add-reminder'),
    tabs: $('tabs'),
    filters: $('filters'),
    list: $('list'),
    showDone: $('show-done'),
    note: $('foot-note'),
    editView: $('edit-view'),
    editBack: $('edit-back'),
    editHeading: $('edit-heading'),
    editBody: $('edit-body'),
  };

  const state = {
    tab: readPref('tab', 'today'),
    filter: readPref('filter', 'all'), // 'all' | 'none' | section id
    showDone: readPref('showDone', '0') === '1',
    items: [],
    categories: [],
    settings: { allDayReminderTime: '09:00', defaultReminderMin: 10, snoozeMin: 10 },
    flashId: null,
    error: null,
    busy: false,
  };
  if (!TABS.some((t) => t.id === state.tab)) state.tab = 'today';

  let holdUntil = 0;
  let renderTimer = null;

  // ---------- helpers ----------

  function readPref(key, fallback) {
    try {
      return win.localStorage.getItem(`dayline:${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      win.localStorage.setItem(`dayline:${key}`, value);
    } catch { /* storage can be unavailable; it is only a convenience */ }
  }

  const todayStr = () => toDateStr(now());
  const findCategoryByTag = (tag) => state.categories.find((c) => normTag(c.name) === normTag(tag));

  function tagToName(tag) {
    const words = tag.replace(/[_-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function nextColor() {
    const used = new Set(state.categories.map((c) => c.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[state.categories.length % COLORS.length];
  }

  // ---------- data ----------

  async function load() {
    const s = await store.getState();
    state.items = s.items;
    state.categories = s.categories;
    state.settings = s.settings;
    if (state.filter !== 'all' && state.filter !== 'none'
      && !state.categories.some((c) => c.id === state.filter)) {
      state.filter = 'all';
    }
  }

  function scheduleRender() {
    const wait = holdUntil - Date.now();
    win.clearTimeout(renderTimer);
    if (wait > 0) renderTimer = win.setTimeout(render, wait);
    else render();
  }

  async function refresh() {
    await load();
    scheduleRender();
  }

  // ---------- rendering ----------

  function render() {
    const views = buildViews(state.items, now(), { showDone: state.showDone, category: state.filter });
    el.dateLabel.textContent = formatDate(todayStr());
    renderTabs(views);
    renderFilters();
    renderList(views);
    renderFooter(views);
    renderSelects();
    renderPreview();
    state.flashId = null;
  }

  function renderTabs(views) {
    for (const btn of el.tabs.children) {
      const id = btn.dataset.tab;
      btn.setAttribute('aria-selected', String(id === state.tab));
      btn.tabIndex = id === state.tab ? 0 : -1;
      const badge = btn.querySelector('.count');
      const n = views.counts[id];
      badge.textContent = String(n);
      badge.hidden = n === 0;
      badge.classList.toggle('alert', id === 'today' && views.today.overdue.length > 0);
    }
  }

  function renderFilters() {
    const cats = state.categories;
    el.filters.hidden = cats.length === 0;
    if (!cats.length) return;
    const chip = (value, label, color) => h('button', {
      type: 'button', class: 'fchip', 'aria-pressed': String(state.filter === value), dataset: { filter: value },
    }, color && h('i', { class: 'dot', dataset: { color } }), label);
    el.filters.replaceChildren(
      chip('all', 'All'),
      ...cats.map((c) => chip(c.id, c.name, c.color)),
      chip('none', 'No section'),
    );
  }

  function renderFooter(views) {
    const open = views.counts.today;
    el.note.textContent = open === 0 ? 'All clear today' : `${open} left today`;
    el.showDone.checked = state.showDone;
  }

  function renderSelects() {
    const wantRem = String(state.settings.defaultReminderMin ?? 'none');
    if (el.reminder.value !== wantRem) el.reminder.value = wantRem;

    const cur = el.category.value;
    el.category.replaceChildren(
      h('option', { value: '' }, 'No section'),
      ...state.categories.map((c) => h('option', { value: c.id }, c.name)),
    );
    const preferred = state.filter !== 'all' && state.filter !== 'none' ? state.filter : cur;
    el.category.value = state.categories.some((c) => c.id === preferred) ? preferred : '';
    el.category.hidden = state.categories.length === 0;
  }

  function renderPreview() {
    const text = el.input.value.trim();
    const kids = [];
    if (state.error) {
      kids.push(h('span', { class: 'chip error' }, state.error));
    } else if (!text) {
      kids.push('Try “gym every monday 7am”, “7-9 oct trip” or “report friday #work”');
    } else {
      const p = parseQuickAdd(text, now());
      const today = todayStr();
      if (!p.title) kids.push(h('span', { class: 'chip error' }, 'Add a title'));
      if (p.endDate) {
        kids.push(h('span', { class: 'chip' }, icon('calendar'), formatRange({ date: p.date, endDate: p.endDate }, today)));
      } else if (p.date) {
        kids.push(h('span', { class: 'chip' }, icon('calendar'), formatDay(p.date, today)));
      } else {
        kids.push(h('span', { class: 'chip plain' }, 'General · no date'));
      }
      if (p.time) kids.push(h('span', { class: 'chip' }, icon('clock'), p.time));
      if (p.recurrence) kids.push(h('span', { class: 'chip' }, icon('repeat'), repeatLabel(p.recurrence)));
      const rem = remindersFor(p, state.settings.defaultReminderMin);
      if (rem.length) kids.push(h('span', { class: 'chip plain' }, icon('bell'), offsetLabel(rem[0].offsetMin)));
      if (p.categoryTag) {
        const match = findCategoryByTag(p.categoryTag);
        if (match) {
          kids.push(h('span', { class: 'chip sect' }, h('i', { class: 'dot', dataset: { color: match.color } }), match.name));
        } else {
          kids.push(h('span', { class: 'chip plain' }, icon('plus'), `New section “${tagToName(p.categoryTag)}”`));
        }
      }
    }
    el.preview.replaceChildren(...kids);
  }

  function renderList(views) {
    const today = todayStr();
    const nodes = [];
    const section = (title, rows, opts = {}) => {
      nodes.push(
        h('div', { class: 'section' },
          title && h('div', { class: `section-head${opts.overdue ? ' overdue' : ''}` }, title, opts.sub && h('span', { class: 'sub' }, opts.sub)),
          h('ul', { class: 'card' }, rows.map((r) => rowEl(r, opts.mode ?? state.tab, today)))),
      );
    };

    if (state.tab === 'today') {
      const { overdue, rows, completed } = views.today;
      if (overdue.length) section(`Overdue · ${overdue.length}`, overdue, { overdue: true });
      if (rows.length) section(overdue.length ? 'Today' : '', rows);
      if (state.showDone && completed.length) section('Completed', completed, { mode: 'completed' });
      if (!nodes.length) nodes.push(emptyEl('today'));
    } else if (state.tab === 'upcoming') {
      const { groups, later } = views.upcoming;
      for (const g of groups) {
        const day = formatDay(g.date, today);
        section(day, g.rows, { sub: day === 'Tomorrow' ? formatDate(g.date) : '' });
      }
      if (later.length) section('Later', later, { mode: 'later' });
      if (!nodes.length) nodes.push(emptyEl('upcoming'));
    } else {
      if (views.general.length) section('', views.general);
      else nodes.push(emptyEl('general'));
    }
    el.list.replaceChildren(...nodes);
  }

  function emptyEl(tab) {
    const [head, sub] = EMPTY[tab];
    return h('div', { class: 'empty' }, h('strong', {}, head), h('span', {}, sub));
  }

  function rowEl(row, mode, today) {
    const { item } = row;
    const meta = [];

    if (row.overdue) {
      meta.push(h('span', { class: 'late' }, `Overdue · ${formatDay(row.date, today)}${!item.endDate && item.time ? ` ${item.time}` : ''}`));
      if (item.endDate) meta.push(h('span', {}, formatRange(item, today)));
    } else if (mode === 'later' || mode === 'completed') {
      meta.push(h('span', {}, `${formatRange(item, today)} · ${formatWhen(item)}`));
    } else if (row.span) {
      meta.push(h('span', { class: 'span' }, spanLabel(row.span)));
      meta.push(h('span', {}, `${formatRange(item, today)}${item.time && row.span.index === 1 ? ` · ${formatWhen(item)}` : ''}`));
    } else if (row.date) {
      meta.push(h('span', {}, formatWhen(item)));
    }
    if (item.recurrence) meta.push(h('span', {}, icon('repeat'), repeatLabel(item.recurrence)));
    if (!row.done && item.date && item.reminders.length) {
      meta.push(h('span', {}, icon('bell'), remindersSummary(item)));
    }
    const cat = state.filter === 'all' ? categoryOf(item, state.categories) : null;
    if (cat) meta.push(h('span', { class: 'sect' }, h('i', { class: 'dot', dataset: { color: cat.color } }), cat.name));

    const check = h('input', {
      type: 'checkbox',
      class: 'check',
      'aria-label': `${row.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
    });
    check.checked = row.done;

    const edit = h('button', {
      type: 'button', class: 'iconbtn edit', 'aria-label': `Edit ${item.title}`, title: 'Edit',
    }, icon('pencil'));
    const del = h('button', {
      type: 'button', class: 'iconbtn del', 'aria-label': `Delete ${item.title}`, title: 'Delete',
    }, icon('trash'), h('span', { class: 'lbl' }, item.recurrence ? 'Delete series?' : 'Delete?'));

    return h('li', {
      class: ['row', row.done && 'done', row.overdue && 'overdue', item.id === state.flashId && 'new'].filter(Boolean).join(' '),
      dataset: { id: item.id, date: row.date ?? '' },
    },
    check,
    h('div', { class: 'body' }, h('div', { class: 'title' }, item.title), meta.length > 0 && h('div', { class: 'meta' }, meta)),
    h('div', { class: 'acts' }, edit, del));
  }

  // ---------- adding ----------

  function showError(message) {
    state.error = message;
    renderPreview();
  }

  async function resolveSection(tag) {
    if (!tag) return el.category.value || null;
    const match = findCategoryByTag(tag);
    if (match) return match.id;
    const created = await store.addCategory({ name: tagToName(tag), color: nextColor() });
    state.categories = [...state.categories, created];
    return created.id;
  }

  async function submit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const text = el.input.value.trim();
    if (!text) return;
    const p = parseQuickAdd(text, now());
    if (!p.title) return showError('Add a title first');
    state.busy = true;
    try {
      const categoryId = await resolveSection(p.categoryTag);
      const item = await store.add({
        title: p.title,
        date: p.date,
        endDate: p.endDate,
        time: p.time,
        recurrence: p.recurrence,
        categoryId,
        type: p.time || p.endDate ? 'event' : 'task',
        reminders: remindersFor(p, state.settings.defaultReminderMin),
      });
      el.input.value = '';
      state.error = null;
      state.flashId = item.id;
      state.tab = !item.date ? 'general' : item.date <= todayStr() ? 'today' : 'upcoming';
      writePref('tab', state.tab);
      // Keep the new item visible: a filter for another section would hide it.
      if (state.filter !== 'all' && state.filter !== (item.categoryId ?? 'none')) {
        state.filter = 'all';
        writePref('filter', 'all');
      }
      await load();
      render();
      state.flashId = item.id; // keep the highlight if a storage event re-renders right away
      win.setTimeout(() => { state.flashId = null; }, 1500);
    } catch (e) {
      showError(e.message || 'Could not add');
    } finally {
      state.busy = false;
    }
    return undefined;
  }

  // ---------- editing ----------

  function openEdit(id) {
    const item = state.items.find((it) => it.id === id);
    if (!item) return;
    el.editHeading.textContent = 'Edit';
    el.editBody.replaceChildren(createItemForm(doc, {
      item,
      categories: state.categories,
      onSave: async (values) => {
        await store.update(id, values);
        state.flashId = id;
        closeEdit();
        await refresh();
      },
      onCancel: closeEdit,
      onDelete: async () => {
        await store.remove(id);
        closeEdit();
        await refresh();
      },
    }));
    el.main.hidden = true;
    el.editView.hidden = false;
  }

  function closeEdit() {
    el.editView.hidden = true;
    el.main.hidden = false;
    el.editBody.replaceChildren();
    el.input.focus();
  }

  // ---------- interactions ----------

  async function onToggle(cb) {
    const li = cb.closest('li.row');
    li.classList.toggle('done', cb.checked);
    holdUntil = Date.now() + animationMs; // let the strike-through show before the row leaves
    try {
      await store.setDone(li.dataset.id, cb.checked, li.dataset.date || undefined);
    } catch (e) {
      cb.checked = !cb.checked;
      li.classList.toggle('done', cb.checked);
      showError(e.message || 'Could not update');
    }
    await refresh();
  }

  function onDelete(btn) {
    const li = btn.closest('li.row');
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      win.setTimeout(() => btn.classList.remove('confirm'), 3000);
      return;
    }
    store.remove(li.dataset.id).then(refresh, (e) => showError(e.message || 'Could not delete'));
  }

  // ---------- setup ----------

  for (const t of TABS) {
    el.tabs.append(h('button', {
      type: 'button', class: 'tab', role: 'tab', dataset: { tab: t.id },
    }, t.label, h('span', { class: 'count' }, '0')));
  }
  for (const c of REMINDER_CHOICES) {
    el.reminder.append(h('option', { value: String(c.value ?? 'none') }, c.label));
  }
  el.addBtn.append(icon('plus'));
  el.options.append(icon('sliders'));
  el.editBack.append(icon('back'));

  const selectTab = (id) => {
    state.tab = id;
    writePref('tab', id);
    render();
  };

  el.tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (btn) selectTab(btn.dataset.tab);
  });
  el.tabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === state.tab);
    const next = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next.id);
    el.tabs.querySelector(`[data-tab="${next.id}"]`).focus();
  });
  el.filters.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.fchip');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    writePref('filter', state.filter);
    render();
  });

  el.form.addEventListener('submit', submit);
  el.input.addEventListener('input', () => {
    state.error = null;
    renderPreview();
  });
  el.reminder.addEventListener('change', async () => {
    const v = el.reminder.value;
    state.settings = await store.updateSettings({ defaultReminderMin: v === 'none' ? null : Number(v) });
    renderPreview();
  });
  el.showDone.addEventListener('change', () => {
    state.showDone = el.showDone.checked;
    writePref('showDone', state.showDone ? '1' : '0');
    render();
  });
  el.options.addEventListener('click', () => openOptions());
  el.editBack.addEventListener('click', closeEdit);
  doc.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.editView.hidden) closeEdit();
  });

  el.list.addEventListener('change', (ev) => {
    if (ev.target.matches('input.check')) onToggle(ev.target);
  });
  el.list.addEventListener('click', (ev) => {
    const del = ev.target.closest('button.del');
    if (del) return onDelete(del);
    const li = ev.target.closest('li.row');
    if (!li || ev.target.closest('input.check')) return undefined;
    if (ev.target.closest('.body') || ev.target.closest('button.edit')) openEdit(li.dataset.id);
    return undefined;
  });

  const tick = win.setInterval(() => render(), 60_000);

  const ready = load().then(() => {
    render();
    el.input.focus();
  });

  return {
    ready,
    refresh,
    destroy() {
      win.clearInterval(tick);
      win.clearTimeout(renderTimer);
    },
  };
}
