// Popup UI. mountPopup() takes a Document and a store, so the same code runs in
// the extension popup and in jsdom tests. All text is inserted with textContent /
// text nodes, never innerHTML: titles come from the user and from imported files.

import { toDateStr } from '../lib/dates.js';
import { parseQuickAdd } from '../lib/parser.js';
import {
  buildViews, formatDate, formatDay, formatWhen, offsetLabel, remindersFor, remindersSummary,
  repeatLabel, REMINDER_CHOICES,
} from '../lib/views.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
  repeat: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2'],
  calendar: ['M3 4h18v18H3z', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
};

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

export function mountPopup(doc, store, { now = () => new Date(), animationMs = 450 } = {}) {
  const win = doc.defaultView;
  const $ = (id) => doc.getElementById(id);
  const el = {
    dateLabel: $('date-label'),
    form: $('add-form'),
    input: $('add-input'),
    addBtn: $('add-btn'),
    preview: $('preview'),
    reminder: $('add-reminder'),
    tabs: $('tabs'),
    list: $('list'),
    showDone: $('show-done'),
    note: $('foot-note'),
  };

  const state = {
    tab: readPref('tab', 'today'),
    showDone: readPref('showDone', '0') === '1',
    items: [],
    settings: { allDayReminderTime: '09:00', defaultReminderMin: 10 },
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

  function h(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'object' ? c : doc.createTextNode(String(c)));
    }
    return node;
  }

  function icon(name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })) svg.setAttribute(k, v);
    for (const d of ICONS[name]) {
      const p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  const todayStr = () => toDateStr(now());

  // ---------- data ----------

  async function load() {
    const [items, settings] = await Promise.all([store.list(), store.getSettings()]);
    state.items = items;
    state.settings = settings;
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
    const views = buildViews(state.items, now(), { showDone: state.showDone });
    el.dateLabel.textContent = formatDate(todayStr());
    renderTabs(views);
    renderList(views);
    renderFooter(views);
    renderReminderSelect();
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

  function renderFooter(views) {
    const open = views.counts.today;
    el.note.textContent = open === 0 ? 'All clear today' : `${open} left today`;
    el.showDone.checked = state.showDone;
  }

  function renderReminderSelect() {
    const want = String(state.settings.defaultReminderMin ?? 'none');
    if (el.reminder.value !== want) el.reminder.value = want;
  }

  function renderPreview() {
    const text = el.input.value.trim();
    const kids = [];
    if (state.error) {
      kids.push(h('span', { class: 'chip error' }, state.error));
    } else if (!text) {
      kids.push('Try “gym every monday 7am” or “call mom in 2 hours”');
    } else {
      const p = parseQuickAdd(text, now());
      const today = todayStr();
      if (!p.title) kids.push(h('span', { class: 'chip error' }, 'Add a title'));
      if (p.date) kids.push(h('span', { class: 'chip' }, icon('calendar'), formatDay(p.date, today)));
      else kids.push(h('span', { class: 'chip plain' }, 'General · no date'));
      if (p.time) kids.push(h('span', { class: 'chip' }, icon('clock'), p.time));
      if (p.recurrence) kids.push(h('span', { class: 'chip' }, icon('repeat'), repeatLabel(p.recurrence)));
      const rem = remindersFor(p, state.settings.defaultReminderMin);
      if (rem.length) kids.push(h('span', { class: 'chip plain' }, icon('bell'), offsetLabel(rem[0].offsetMin)));
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
      meta.push(h('span', { class: 'late' }, `Overdue · ${formatDay(row.date, today)}${item.time ? ` ${item.time}` : ''}`));
    } else if (mode === 'later' || mode === 'completed') {
      meta.push(h('span', {}, `${formatDay(row.date, today)} · ${formatWhen(item)}`));
    } else if (row.date) {
      meta.push(h('span', {}, formatWhen(item)));
    }
    if (item.recurrence) meta.push(h('span', {}, icon('repeat'), repeatLabel(item.recurrence)));
    if (!row.done && item.date && item.reminders.length) {
      meta.push(h('span', {}, icon('bell'), remindersSummary(item)));
    }

    const check = h('input', {
      type: 'checkbox',
      class: 'check',
      'aria-label': `${row.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
    });
    check.checked = row.done;

    const del = h('button', {
      type: 'button',
      class: 'del',
      'aria-label': `Delete ${item.title}`,
      title: 'Delete',
    }, icon('trash'), h('span', { class: 'lbl' }, item.recurrence ? 'Delete series?' : 'Delete?'));

    return h('li', {
      class: ['row', row.done && 'done', row.overdue && 'overdue', item.id === state.flashId && 'new'].filter(Boolean).join(' '),
      dataset: { id: item.id, date: row.date ?? '' },
    },
    check,
    h('div', { class: 'body' }, h('div', { class: 'title' }, item.title), meta.length > 0 && h('div', { class: 'meta' }, meta)),
    del);
  }

  // ---------- interactions ----------

  function showError(message) {
    state.error = message;
    renderPreview();
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
      const item = await store.add({
        title: p.title,
        date: p.date,
        time: p.time,
        recurrence: p.recurrence,
        type: p.time ? 'event' : 'task',
        reminders: remindersFor(p, state.settings.defaultReminderMin),
      });
      el.input.value = '';
      state.error = null;
      state.flashId = item.id;
      state.tab = !item.date ? 'general' : item.date <= todayStr() ? 'today' : 'upcoming';
      writePref('tab', state.tab);
      await load();
      render();
      state.flashId = item.id; // keep the highlight if a storage event re-renders right away
      win.setTimeout(() => { state.flashId = null; }, 1500);
    } catch (e) {
      showError(e.message || 'Could not add');
    } finally {
      state.busy = false;
    }
  }

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

  el.tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    writePref('tab', state.tab);
    render();
  });
  el.tabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === state.tab);
    const next = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    state.tab = next.id;
    writePref('tab', state.tab);
    render();
    el.tabs.querySelector(`[data-tab="${next.id}"]`).focus();
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
  el.list.addEventListener('change', (ev) => {
    if (ev.target.matches('input.check')) onToggle(ev.target);
  });
  el.list.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.del');
    if (btn) onDelete(btn);
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
