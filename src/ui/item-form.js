// Edit form for one item. Used in the popup today and reusable for the full calendar page.
// createItemForm() returns an element; it never touches storage itself: the caller passes
// onSave(values) (returns a promise; throwing shows the message inline), onCancel, onDelete.

import { parseDateStr } from '../lib/dates.js';
import { LIMITS } from '../lib/model.js';
import { offsetLabel } from '../lib/views.js';
import { createH, createIcon } from './dom.js';

const PRESET_OFFSETS = [0, 5, 10, 30, 60, 120, 1440, 2880];
const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {Document} doc
 * @param {{item: object, categories: object[], onSave: Function, onCancel: Function, onDelete: Function}} o
 */
export function createItemForm(doc, { item, categories, onSave, onCancel, onDelete }) {
  const h = createH(doc);
  const icon = createIcon(doc);
  const uid = `f${Math.random().toString(36).slice(2, 8)}`;
  const id = (name) => `${uid}-${name}`;

  const input = (name, props = {}) => h('input', { class: 'input', id: id(name), ...props });
  const field = (label, control, name, extra = {}) =>
    h('div', { class: `field ${extra.class ?? ''}`, dataset: extra.dataset },
      h('label', { for: id(name) }, label), control);

  // ----- controls -----
  const title = input('title', { type: 'text', maxlength: String(LIMITS.title), required: true });
  title.value = item.title;

  const type = h('select', { class: 'select', id: id('type') },
    h('option', { value: 'task' }, 'Task'), h('option', { value: 'event' }, 'Event'));
  type.value = item.type;

  const category = h('select', { class: 'select', id: id('category') },
    h('option', { value: '' }, 'No section'),
    categories.map((c) => h('option', { value: c.id }, c.name)));
  category.value = categories.some((c) => c.id === item.categoryId) ? item.categoryId : '';

  const date = input('date', { type: 'date' });
  date.value = item.date ?? '';
  const endDate = input('endDate', { type: 'date' });
  endDate.value = item.endDate ?? '';
  const time = input('time', { type: 'time' });
  time.value = item.time ?? '';
  const endTime = input('endTime', { type: 'time' });
  endTime.value = item.endTime ?? '';

  const repeat = h('select', { class: 'select', id: id('repeat') },
    h('option', { value: 'none' }, 'Does not repeat'),
    h('option', { value: 'daily' }, 'Daily'),
    h('option', { value: 'weekly' }, 'Weekly'),
    h('option', { value: 'monthly' }, 'Monthly'));
  repeat.value = item.recurrence?.freq ?? 'none';
  const interval = input('interval', { type: 'number', min: '1', max: '365', step: '1' });
  interval.value = String(item.recurrence?.interval ?? 1);
  const intervalUnit = h('span', { class: 'unit' }, '');
  const until = input('until', { type: 'date' });
  until.value = item.recurrence?.until ?? '';

  const weekdayBoxes = WEEKDAY_LETTERS.map((letter, i) => {
    const box = h('input', { type: 'checkbox', value: String(i), 'aria-label': WEEKDAY_NAMES[i] });
    box.checked = item.recurrence?.weekdays?.includes(i) ?? false;
    return { i, box, el: h('label', { class: 'day', title: WEEKDAY_NAMES[i] }, box, h('span', {}, letter)) };
  });

  const offsets = [...new Set([...PRESET_OFFSETS, ...item.reminders.map((r) => r.offsetMin)])].sort((a, b) => a - b);
  const reminderBoxes = offsets.map((min) => {
    const box = h('input', { type: 'checkbox', value: String(min) });
    box.checked = item.reminders.some((r) => r.offsetMin === min);
    return { min, box, el: h('label', { class: 'pill' }, box, h('span', {}, offsetLabel(min))) };
  });
  const reminderHint = h('div', { class: 'hint' }, 'Add a date to set reminders.');

  const notes = h('textarea', { class: 'textarea', id: id('notes'), maxlength: String(LIMITS.notes), rows: '3' });
  notes.value = item.notes;

  const error = h('div', { class: 'form-error', role: 'alert', hidden: true });

  // ----- layout -----
  const endDateField = field('Ends on (multi-day)', endDate, 'endDate', { dataset: { role: 'endDate' } });
  const timeRow = h('div', { class: 'row2', dataset: { role: 'times' } },
    field('Start time', time, 'time'), field('End time', endTime, 'endTime'));
  const repeatBox = h('div', { class: 'repeat-box', dataset: { role: 'repeat-opts' } },
    h('div', { class: 'every' }, h('span', {}, 'Every'), interval, intervalUnit),
    h('div', { class: 'days', dataset: { role: 'weekdays' } }, weekdayBoxes.map((w) => w.el)),
    field('Until (optional)', until, 'until'));

  const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('check'), 'Save');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const deleteBtn = h('button', { type: 'button', class: 'btn danger' }, icon('trash'), 'Delete');

  const form = h('form', { class: 'item-form', novalidate: true },
    item.recurrence ? h('div', { class: 'note' }, 'Changes apply to every occurrence of this repeating item.') : null,
    field('Title', title, 'title'),
    h('div', { class: 'row2' }, field('Section', category, 'category'), field('Type', type, 'type')),
    field('Date', date, 'date'),
    endDateField,
    timeRow,
    field('Repeat', repeat, 'repeat'),
    repeatBox,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Reminders'),
      h('div', { class: 'pills' }, reminderBoxes.map((r) => r.el)), reminderHint),
    field('Notes', notes, 'notes'),
    error,
    h('div', { class: 'actions' }, saveBtn, cancelBtn, h('span', { class: 'grow' }), deleteBtn));

  // ----- behaviour -----
  function syncVisibility() {
    const hasDate = Boolean(date.value);
    const repeating = repeat.value !== 'none';
    endDateField.hidden = !hasDate || repeating;
    timeRow.hidden = !hasDate;
    repeat.closest('.field').hidden = !hasDate;
    repeatBox.hidden = !hasDate || !repeating;
    repeatBox.querySelector('[data-role=weekdays]').hidden = repeat.value !== 'weekly';
    intervalUnit.textContent = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)' }[repeat.value] ?? '';
    for (const r of reminderBoxes) r.box.disabled = !hasDate;
    reminderHint.hidden = hasDate;
    endDate.min = date.value || '';
    if (endDate.value && date.value && endDate.value <= date.value) endDate.value = '';
  }

  date.addEventListener('change', syncVisibility);
  repeat.addEventListener('change', () => {
    if (repeat.value === 'weekly' && date.value && !weekdayBoxes.some((w) => w.box.checked)) {
      weekdayBoxes[parseDateStr(date.value).getDay()].box.checked = true;
    }
    syncVisibility();
  });
  syncVisibility();

  function readValues() {
    const hasDate = Boolean(date.value);
    let recurrence = null;
    if (hasDate && repeat.value !== 'none') {
      const n = Number.parseInt(interval.value, 10);
      recurrence = { freq: repeat.value, interval: Number.isFinite(n) && n >= 1 ? n : 1 };
      if (repeat.value === 'weekly') {
        const days = weekdayBoxes.filter((w) => w.box.checked).map((w) => w.i);
        if (days.length) recurrence.weekdays = days;
      }
      if (until.value) recurrence.until = until.value;
    }
    return {
      title: title.value,
      notes: notes.value,
      type: type.value,
      categoryId: category.value || null,
      date: hasDate ? date.value : null,
      endDate: hasDate && !recurrence && endDate.value ? endDate.value : null,
      time: hasDate && time.value ? time.value : null,
      endTime: hasDate && time.value && endTime.value ? endTime.value : null,
      recurrence,
      reminders: hasDate
        ? reminderBoxes.filter((r) => r.box.checked).map((r) => ({ offsetMin: r.min }))
        : [],
    };
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showError('');
    const values = readValues();
    if (!values.title.trim()) return showError('Give it a title.');
    if (values.recurrence?.until && values.recurrence.until < values.date) {
      return showError('"Until" is before the start date.');
    }
    saveBtn.disabled = true;
    try {
      await onSave(values);
    } catch (e) {
      showError(e?.message || 'Could not save.');
      saveBtn.disabled = false;
    }
    return undefined;
  });

  cancelBtn.addEventListener('click', () => onCancel());

  let confirmTimer = null;
  deleteBtn.addEventListener('click', async () => {
    if (!deleteBtn.classList.contains('confirm')) {
      deleteBtn.classList.add('confirm');
      deleteBtn.lastChild.textContent = item.recurrence ? 'Delete series?' : 'Sure?';
      confirmTimer = setTimeout(() => {
        deleteBtn.classList.remove('confirm');
        deleteBtn.lastChild.textContent = 'Delete';
      }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    try {
      await onDelete();
    } catch (e) {
      showError(e?.message || 'Could not delete.');
    }
  });

  queueMicrotask(() => { if (!item.title) title.focus(); });
  return form;
}
