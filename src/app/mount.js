// Full-page app: month calendar with selectable days, and the "All" list with search
// and filters. mountCalendar(doc, store, {now, openOptions}) -> { refresh }.
// All user text goes through textContent / text nodes, never innerHTML.

import {
  filterAll, dayRows, monthGrid, monthTitle, selectDay, selectionTarget,
} from '../lib/calendar.js';
import { addDays, diffDays, parseDateStr, toDateStr } from '../lib/dates.js';
import { slotsOn } from '../lib/recurrence.js';
import { COLORS } from '../lib/model.js';
import { parseQuickAdd } from '../lib/parser.js';
import {
  categoryOf, formatDate, formatDay, formatRange, formatWhen, remindersFor, remindersSummary,
  repeatLabel, spanLabel,
} from '../lib/views.js';
import { createH, createIcon } from '../ui/dom.js';
import { createItemForm } from '../ui/item-form.js';

const WEEKDAY_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_CHIPS = 3;
const normTag = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');

export function mountCalendar(doc, store, { now = () => new Date(), openOptions = () => {} } = {}) {
  const h = createH(doc);
  const icon = createIcon(doc);
  const $ = (id) => doc.getElementById(id);
  const el = {
    views: $('views'), calView: $('calendar-view'), allView: $('all-view'),
    title: $('month-title'), grid: $('grid'), dow: $('dow'), panel: $('panel'),
    prev: $('prev'), next: $('next'), today: $('today-btn'), multi: $('multi-btn'),
    filters: $('all-filters'), list: $('all-list'), options: $('open-options'),
  };

  const t0 = now();
  const state = {
    view: 'calendar',
    year: t0.getFullYear(),
    month: t0.getMonth(),
    multi: false, // "Select several days" mode: every click adds or removes a day
    selected: [toDateStr(t0)],
    anchor: toDateStr(t0),
    items: [], categories: [], settings: {},
    editing: null, // {id} | {draft: item}
    filter: { query: '', status: 'open', category: 'all', when: 'any', from: '', to: '' },
    error: '',
  };
  const todayStr = () => toDateStr(now());

  // ---------- data ----------

  async function load() {
    const s = await store.getState();
    state.items = s.items;
    state.categories = s.categories;
    state.settings = s.settings;
    if (state.filter.category !== 'all' && state.filter.category !== 'none'
      && !state.categories.some((c) => c.id === state.filter.category)) state.filter.category = 'all';
    if (state.editing?.id && !state.items.some((i) => i.id === state.editing.id)) state.editing = null;
  }

  async function refresh() {
    await load();
    render();
  }

  // ---------- chrome: view switch ----------

  function renderViews() {
    el.views.replaceChildren(...[['calendar', 'Calendar'], ['all', 'All']].map(([id, label]) => {
      const b = h('button', {
        type: 'button', class: 'vtab', role: 'tab', 'aria-selected': String(state.view === id), dataset: { view: id },
      }, label);
      b.addEventListener('click', () => {
        state.view = id;
        state.editing = null;
        render();
      });
      return b;
    }));
    el.calView.hidden = state.view !== 'calendar';
    el.allView.hidden = state.view !== 'all';
  }

  // ---------- calendar ----------

  function showMonth(year, month0) {
    const d = new Date(year, month0, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
  }

  function renderGrid() {
    el.title.textContent = monthTitle(state.year, state.month);
    el.dow.replaceChildren(...WEEKDAY_HEAD.map((d) => h('div', {}, d)));
    const weeks = monthGrid(state.year, state.month, 1);
    const flat = weeks.flat();
    const rows = dayRows(state.items, flat[0], flat[flat.length - 1], now());
    const today = todayStr();
    const sel = new Set(state.selected);

    el.grid.replaceChildren(...flat.map((date) => {
      const list = (rows.get(date) ?? []).filter((r) => r.item.showOnCalendar !== false);
      const day = parseDateStr(date);
      const inMonth = day.getMonth() === state.month;
      const open = list.filter((r) => !r.done).length;
      const chips = list.slice(0, MAX_CHIPS).map((r) => {
        const cat = categoryOf(r.item, state.categories);
        return h('span', {
          class: `dchip${r.done ? ' done' : ''}${r.overdue ? ' late' : ''}`,
          dataset: cat ? { color: cat.color } : {},
        }, h('i', { class: 'dot' }), r.item.title);
      });
      const more = list.length - MAX_CHIPS;
      const label = `${formatDate(date)}${list.length ? `, ${open} open of ${list.length}` : ', nothing'}${sel.has(date) ? ', selected' : ''}`;
      const b = h('button', {
        type: 'button',
        class: ['day', inMonth ? '' : 'out', date === today ? 'today' : '', sel.has(date) ? 'sel' : ''].filter(Boolean).join(' '),
        'aria-pressed': String(sel.has(date)),
        'aria-label': label,
        dataset: { date, count: String(list.length) },
      },
      h('span', { class: 'num' }, String(day.getDate())),
      h('span', { class: 'chips' }, chips, more > 0 && h('span', { class: 'more' }, `+${more} more`)));
      b.addEventListener('click', (ev) => onDayClick(date, ev));
      b.addEventListener('keydown', onDayKey);
      return b;
    }));
  }

  function onDayClick(date, ev) {
    const next = selectDay(state, date, { ctrl: ev.ctrlKey || ev.metaKey || state.multi, shift: ev.shiftKey });
    state.selected = next.selected;
    state.anchor = next.anchor;
    state.editing = null;
    state.error = '';
    // Clicking a greyed-out day of a neighbouring month jumps to that month.
    const d = parseDateStr(date);
    if (d.getMonth() !== state.month && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !state.multi) showMonth(d.getFullYear(), d.getMonth());
    renderGrid();
    renderPanel();
    el.grid.querySelector(`[data-date="${date}"]`)?.focus();
  }

  function onDayKey(ev) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const target = addDays(ev.currentTarget.dataset.date, step);
    const node = el.grid.querySelector(`[data-date="${target}"]`);
    if (node) node.focus();
  }

  const shiftMonth = (n) => { showMonth(state.year, state.month + n); renderGrid(); };
  el.multi.addEventListener('click', () => {
    state.multi = !state.multi;
    el.multi.setAttribute('aria-pressed', String(state.multi));
  });
  el.prev.addEventListener('click', () => shiftMonth(-1));
  el.next.addEventListener('click', () => shiftMonth(1));
  el.today.addEventListener('click', () => {
    const t = now();
    showMonth(t.getFullYear(), t.getMonth());
    state.selected = [toDateStr(t)];
    state.anchor = state.selected[0];
    state.editing = null;
    renderGrid();
    renderPanel();
  });

  // ---------- panel (selected days) ----------

  function panelTitle() {
    const n = state.selected.length;
    if (n === 0) return 'No day selected';
    if (n === 1) return formatDay(state.selected[0], todayStr());
    return `${n} days selected`;
  }

  function renderPanel() {
    if (state.editing) {
      el.panel.replaceChildren(editCard());
      return;
    }
    const kids = [];
    kids.push(h('div', { class: 'panel-head' },
      h('h2', {}, panelTitle()),
      state.selected.length > 0 && h('button', { type: 'button', class: 'btn small', id: 'clear-sel' }, 'Clear')));

    if (!state.selected.length) {
      kids.push(h('div', { class: 'empty' },
        h('strong', {}, 'Pick a day'),
        h('span', {}, 'Select one or more days to see what is on them and to add something there.')));
      el.panel.replaceChildren(...kids);
      el.panel.querySelector('#clear-sel')?.addEventListener('click', clearSelection);
      return;
    }

    kids.push(quickAddEl());

    const from = state.selected[0];
    const to = state.selected[state.selected.length - 1];
    const map = dayRows(state.items, from, to, now());
    let total = 0;
    for (const date of state.selected) {
      const rows = map.get(date) ?? [];
      total += rows.length;
      kids.push(h('section', { class: 'day-block', dataset: { date } },
        state.selected.length > 1 && h('h3', {}, formatDay(date, todayStr())),
        rows.length
          ? h('ul', { class: 'rows' }, rows.map((r) => rowEl(r, { showDate: false })))
          : h('p', { class: 'none' }, 'Nothing on this day.')));
    }
    if (state.selected.length > 1 && total === 0) kids.push(h('p', { class: 'none' }, 'Nothing on these days.'));
    el.panel.replaceChildren(...kids);
    el.panel.querySelector('#clear-sel')?.addEventListener('click', clearSelection);
  }

  function clearSelection() {
    state.selected = [];
    state.anchor = null;
    renderGrid();
    renderPanel();
  }

  // ---------- adding ----------

  function targetLabel() {
    const { date, endDate } = selectionTarget(state.selected);
    if (!date) return '';
    return endDate ? `${formatDate(date)} – ${formatDate(endDate)}` : formatDate(date);
  }

  function quickAddEl() {
    const input = h('input', {
      class: 'input', id: 'quick-input', type: 'text', maxlength: '300', spellcheck: 'false', autocomplete: 'off',
      placeholder: `Add to ${targetLabel()}…  e.g. “dentist 3pm”`, 'aria-label': 'Quick add to the selected days',
    });
    const submit = h('button', { type: 'submit', class: 'btn primary', id: 'quick-submit' }, icon('plus'), 'Add');
    const details = h('button', { type: 'button', class: 'btn', id: 'quick-details' }, 'More options');
    const err = h('div', { class: 'form-error', role: 'alert', hidden: !state.error }, state.error);
    const form = h('form', { class: 'quick', id: 'quick-form' },
      h('div', { class: 'quick-row' }, input, submit), err, h('div', { class: 'quick-actions' }, details));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      submit.disabled = true;
      try {
        state.error = '';
        await quickAdd(text);
      } catch (e) {
        state.error = e?.message || 'Could not add that.';
        err.textContent = state.error;
        err.hidden = false;
        submit.disabled = false;
      }
    });
    details.addEventListener('click', () => {
      const { date, endDate } = selectionTarget(state.selected);
      const draft = {
        title: input.value.trim(), notes: '', type: endDate ? 'event' : 'task', date, endDate,
        time: null, endTime: null, recurrence: null, categoryId: null,
        reminders: remindersFor({ date, time: null }, state.settings.defaultReminderMin),
      };
      state.editing = { draft };
      render();
    });
    return form;
  }

  async function resolveSection(tag) {
    if (!tag) return null;
    const match = state.categories.find((c) => normTag(c.name) === normTag(tag));
    if (match) return match.id;
    const words = tag.replace(/[_-]+/g, ' ').trim();
    const used = new Set(state.categories.map((c) => c.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[state.categories.length % COLORS.length];
    const created = await store.addCategory({ name: words.charAt(0).toUpperCase() + words.slice(1), color });
    state.categories = [...state.categories, created];
    return created.id;
  }

  /** Quick-add inside the panel: typed dates win, otherwise the selected day(s) are used. */
  async function quickAdd(text) {
    const p = parseQuickAdd(text, now());
    if (!p.title) throw new Error('Add a title first.');
    const target = selectionTarget(state.selected);
    const typedDate = p.matched.some((m) => m.kind === 'date');
    let { date, endDate } = p;
    if (!typedDate && target.date) {
      const length = p.endDate ? diffDays(p.date, p.endDate) : 0;
      date = target.date;
      if (p.endDate) endDate = addDays(date, length);
      else if (!p.recurrence) endDate = target.endDate;
    }
    const categoryId = await resolveSection(p.categoryTag);
    const item = await store.add({
      title: p.title, date, endDate, time: p.time, recurrence: p.recurrence, categoryId,
      type: p.time || endDate ? 'event' : 'task',
      reminders: remindersFor({ date, time: p.time }, state.settings.defaultReminderMin),
    });
    if (state.view === 'calendar' && date) {
      const d = parseDateStr(date);
      if (d.getMonth() !== state.month || d.getFullYear() !== state.year) showMonth(d.getFullYear(), d.getMonth());
    }
    await refresh();
    return item;
  }

  // ---------- edit form ----------

  function editCard() {
    const { id, draft } = state.editing;
    const item = id ? state.items.find((i) => i.id === id) : draft;
    const close = async () => { state.editing = null; await refresh(); };
    const back = h('button', { type: 'button', class: 'iconbtn', id: 'edit-back', 'aria-label': 'Back', title: 'Back' }, icon('back'));
    back.addEventListener('click', close);
    return h('div', { class: 'edit-card' },
      h('div', { class: 'panel-head' }, back,
        h('h2', {}, id ? 'Edit' : 'New item')),
      createItemForm(doc, {
        item,
        categories: state.categories,
        onSave: async (values) => {
          if (id) await store.update(id, values);
          else await store.add(values);
          if (values.date && state.view === 'calendar') {
            const d = parseDateStr(values.date);
            showMonth(d.getFullYear(), d.getMonth());
          }
          await close();
        },
        onCancel: close,
        onDelete: async () => { await store.remove(id); await close(); },
      }));
  }

  // ---------- rows ----------

  function rowEl(row, { showDate }) {
    const { item } = row;
    const today = todayStr();
    const meta = [];
    if (row.overdue) meta.push(h('span', { class: 'late' }, 'Overdue'));
    if (showDate && item.date) meta.push(h('span', {}, formatRange(item, today)));
    if (row.span) meta.push(h('span', { class: 'span' }, spanLabel(row.span)));
    if (item.date && !item.endDate && item.recurrence?.freq !== 'hourly') meta.push(h('span', {}, icon('clock'), formatWhen(item)));
    else if (item.date && row.span?.index === 1 && item.time) meta.push(h('span', {}, icon('clock'), formatWhen(item)));
    if (item.recurrence) meta.push(h('span', {}, icon('repeat'), repeatLabel(item.recurrence)));
    if (!showDate && item.recurrence?.freq === 'hourly' && row.date) {
      const slots = slotsOn(item, row.date);
      meta.push(h('span', {}, icon('clock'), slots.length > 6 ? `${slots.slice(0, 6).join(', ')} …` : slots.join(', ')));
    }
    if (item.showOnCalendar === false) meta.push(h('span', { title: 'Hidden from the calendar grid' }, icon('eyeoff'), 'Hidden on grid'));
    if (item.date && item.reminders.length && !row.done) meta.push(h('span', {}, icon('bell'), remindersSummary(item)));
    const cat = categoryOf(item, state.categories);
    if (cat) meta.push(h('span', { class: 'sect', dataset: { color: cat.color } }, h('i', { class: 'dot' }), cat.name));

    // No tick box: for notes, for a series shown once in the All list, and for hourly items
    // (tick those one reminder at a time in the toolbar popup).
    const canCheck = item.checkable !== false && !(showDate && item.recurrence)
      && item.recurrence?.freq !== 'hourly';
    const check = canCheck ? h('input', {
      type: 'checkbox', class: 'check', 'aria-label': `${row.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
    }) : h('span', { class: 'check-spacer' });
    if (canCheck) {
      check.checked = row.done;
      check.addEventListener('change', async () => {
        await store.setDone(item.id, check.checked, item.recurrence ? row.date : undefined);
        await refresh();
      });
    }
    const body = h('button', { type: 'button', class: 'body', 'aria-label': `Edit ${item.title}` },
      h('span', { class: 'title' }, item.title), meta.length > 0 && h('span', { class: 'meta' }, meta));
    body.addEventListener('click', () => { state.editing = { id: item.id }; render(); });
    return h('li', {
      class: `row${row.done ? ' done' : ''}${row.overdue ? ' overdue' : ''}`, dataset: { id: item.id, date: row.date ?? '' },
    }, check, body);
  }

  // ---------- "All" view ----------

  function renderAllFilters() {
    const f = state.filter;
    const sel = (name, label, options, value) => {
      const s = h('select', { class: 'select', id: `f-${name}`, 'aria-label': label },
        options.map(([v, l]) => h('option', { value: v }, l)));
      s.value = value;
      s.addEventListener('change', () => { f[name] = s.value; renderAllList(); });
      return h('div', { class: 'field' }, h('label', { for: `f-${name}` }, label), s);
    };
    const query = h('input', {
      class: 'input', id: 'f-query', type: 'search', placeholder: 'Search titles and notes…', 'aria-label': 'Search', value: f.query,
    });
    query.addEventListener('input', () => { f.query = query.value; renderAllList(); });
    const date = (name, label) => {
      const i = h('input', { class: 'input', id: `f-${name}`, type: 'date', 'aria-label': label, value: f[name] });
      i.addEventListener('change', () => { f[name] = i.value; renderAllList(); });
      return h('div', { class: 'field' }, h('label', { for: `f-${name}` }, label), i);
    };
    const clear = h('button', { type: 'button', class: 'btn', id: 'f-clear' }, 'Reset');
    clear.addEventListener('click', () => {
      state.filter = { query: '', status: 'open', category: 'all', when: 'any', from: '', to: '' };
      renderAllFilters();
      renderAllList();
    });
    el.filters.replaceChildren(
      h('div', { class: 'field grow' }, h('label', { for: 'f-query' }, 'Search'), query),
      sel('status', 'Status', [['open', 'Open'], ['done', 'Done'], ['all', 'All']], f.status),
      sel('category', 'Section', [['all', 'All sections'], ...state.categories.map((c) => [c.id, c.name]), ['none', 'No section']], f.category),
      sel('when', 'When', [['any', 'Any time'], ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days'],
        ['dated', 'Has a date'], ['undated', 'General (no date)'], ['repeating', 'Repeating']], f.when),
      date('from', 'From'), date('to', 'To'), clear);
  }

  function renderAllList() {
    if (state.editing) {
      el.list.replaceChildren(h('div', { class: 'all-edit' }, editCard()));
      el.filters.hidden = true;
      return;
    }
    el.filters.hidden = false;
    const items = filterAll(state.items, state.filter, now());
    const head = h('div', { class: 'all-count', id: 'all-count' },
      `${items.length} ${items.length === 1 ? 'item' : 'items'}`);
    if (!items.length) {
      el.list.replaceChildren(head, h('div', { class: 'empty' }, h('strong', {}, 'Nothing matches'),
        h('span', {}, state.items.length ? 'Try a different search or reset the filters.' : 'Add something from the calendar or the toolbar popup.')));
      return;
    }
    const rows = items.map((item) => ({
      item, date: item.date, done: item.recurrence ? false : item.done, overdue: false, span: null,
    }));
    for (const r of rows) r.overdue = isLate(r.item);
    el.list.replaceChildren(head, h('ul', { class: 'rows card' }, rows.map((r) => rowEl(r, { showDate: true }))));
  }

  function isLate(item) {
    if (!item.date || item.recurrence || item.done || item.checkable === false) return false;
    const last = item.endDate ?? item.date;
    const t = now();
    const today = toDateStr(t);
    if (last < today) return true;
    return last === today && Boolean(item.time) && !item.endDate
      && parseDateStr(today).setHours(...item.time.split(':').map(Number)) < t.getTime();
  }

  // ---------- render ----------

  function render() {
    renderViews();
    if (state.view === 'calendar') {
      renderGrid();
      renderPanel();
    } else {
      if (!el.filters.childElementCount) renderAllFilters();
      renderAllList();
    }
  }

  el.options.append(icon('sliders'));
  el.options.addEventListener('click', () => openOptions());

  const ready = load().then(() => {
    renderAllFilters();
    render();
  });
  return { refresh, ready, state };
}
