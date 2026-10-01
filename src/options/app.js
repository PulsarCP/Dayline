// Options page: sections, reminder settings, export/import. mountOptions() takes a
// Document and a store so it can be driven from tests; all text goes through text nodes.

import { COLORS, SNOOZE_CHOICES } from '../lib/model.js';
import { MAX_IMPORT_CHARS } from '../lib/store.js';
import { offsetLabel, REMINDER_CHOICES } from '../lib/views.js';
import { createH, createIcon } from '../ui/dom.js';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function browserDownload(doc, filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = doc.defaultView.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.append(a);
  a.click();
  a.remove();
  doc.defaultView.setTimeout(() => doc.defaultView.URL.revokeObjectURL(url), 2000);
}

export function mountOptions(doc, store, {
  version = '',
  download = (name, text) => browserDownload(doc, name, text),
  confirmReplace = (msg) => doc.defaultView.confirm(msg),
  now = () => new Date(),
} = {}) {
  const h = createH(doc);
  const icon = createIcon(doc);
  const $ = (id) => doc.getElementById(id);
  const el = {
    status: $('status'),
    sections: $('sections'),
    addForm: $('add-section'),
    newName: $('new-name'),
    newColor: $('new-color'),
    defaultReminder: $('default-reminder'),
    allDayTime: $('allday-time'),
    snooze: $('snooze'),
    exportBtn: $('export'),
    importBtn: $('import'),
    importFile: $('import-file'),
    about: $('about'),
  };

  const state = { categories: [], items: [], settings: {} };
  let statusTimer = null;

  function say(message, { error = false, details = [] } = {}) {
    win().clearTimeout(statusTimer);
    el.status.className = `status${error ? ' error' : ''}`;
    const nodes = [message];
    if (details.length) nodes.push(h('ul', {}, details.map((d) => h('li', {}, d))));
    el.status.replaceChildren(...nodes);
    el.status.hidden = false;
    if (!error) statusTimer = win().setTimeout(() => { el.status.hidden = true; }, 6000);
  }
  const win = () => doc.defaultView;

  const guard = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      say(e?.message || 'Something went wrong.', { error: true });
      await load();
      render();
    }
  };

  async function load() {
    const s = await store.getState();
    state.categories = s.categories;
    state.items = s.items;
    state.settings = s.settings;
  }

  const colorOptions = () => COLORS.map((c) => h('option', { value: c }, capitalize(c)));

  function nextColor() {
    const used = new Set(state.categories.map((c) => c.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[state.categories.length % COLORS.length];
  }

  // ---------- sections ----------

  function sectionRow(cat) {
    const used = state.items.filter((it) => it.categoryId === cat.id).length;
    const dot = h('i', { class: 'dot', dataset: { color: cat.color } });
    const name = h('input', {
      class: 'input', type: 'text', maxlength: '30', value: cat.name, 'aria-label': `Name of section ${cat.name}`,
    });
    const color = h('select', { class: 'select color-select', 'aria-label': `Colour of ${cat.name}` }, colorOptions());
    color.value = cat.color;
    const del = h('button', { type: 'button', class: 'btn danger', 'aria-label': `Delete section ${cat.name}` }, icon('trash'), 'Delete');
    const count = h('span', { class: 'count' }, `${used} item${used === 1 ? '' : 's'}`);

    name.addEventListener('change', guard(async () => {
      await store.updateCategory(cat.id, { name: name.value });
      say('Section renamed.');
      await refresh();
    }));
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') name.blur(); });
    color.addEventListener('change', guard(async () => {
      await store.updateCategory(cat.id, { color: color.value });
      dot.dataset.color = color.value;
      await refresh();
    }));
    let timer = null;
    del.addEventListener('click', guard(async () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.lastChild.textContent = used ? `Delete? (${used} item${used === 1 ? '' : 's'} stay)` : 'Delete?';
        timer = win().setTimeout(() => {
          del.classList.remove('confirm');
          del.lastChild.textContent = 'Delete';
        }, 3500);
        return;
      }
      win().clearTimeout(timer);
      const r = await store.removeCategory(cat.id);
      say(r.itemsCleared ? `Section deleted. ${r.itemsCleared} item${r.itemsCleared === 1 ? ' is' : 's are'} now unsectioned.` : 'Section deleted.');
      await refresh();
    }));

    return h('li', { class: 'sec-row' }, dot, h('div', {}, name, count), color, del);
  }

  function renderSections() {
    el.sections.replaceChildren(...state.categories.map(sectionRow));
    el.newColor.value = nextColor();
  }

  // ---------- settings ----------

  function renderSettings() {
    const m = state.settings.defaultReminderMin;
    el.defaultReminder.value = String(m ?? 'none');
    el.allDayTime.value = state.settings.allDayReminderTime;
    el.snooze.value = String(state.settings.snoozeMin);
  }

  // ---------- render / refresh ----------

  function render() {
    renderSections();
    renderSettings();
  }

  async function refresh() {
    await load();
    render();
  }

  // ---------- setup ----------

  el.newColor.append(...colorOptions());
  for (const c of REMINDER_CHOICES) el.defaultReminder.append(h('option', { value: String(c.value ?? 'none') }, c.label));
  for (const m of SNOOZE_CHOICES) el.snooze.append(h('option', { value: String(m) }, `${m} minutes`));
  el.exportBtn.append(icon('download'), 'Export backup');
  el.importBtn.append(icon('upload'), 'Import');
  el.about.textContent = `Dayline${version ? ` ${version}` : ''} · no account, no server, no tracking`;

  el.addForm.addEventListener('submit', guard(async (ev) => {
    ev.preventDefault();
    const name = el.newName.value.trim();
    if (!name) return;
    await store.addCategory({ name, color: el.newColor.value });
    el.newName.value = '';
    say(`Added section “${name}”.`);
    await refresh();
  }));

  el.defaultReminder.addEventListener('change', guard(async () => {
    const v = el.defaultReminder.value;
    await store.updateSettings({ defaultReminderMin: v === 'none' ? null : Number(v) });
    say(`Default reminder: ${v === 'none' ? 'none' : offsetLabel(Number(v))}.`);
  }));
  el.allDayTime.addEventListener('change', guard(async () => {
    if (!el.allDayTime.value) { renderSettings(); return; }
    const s = await store.updateSettings({ allDayReminderTime: el.allDayTime.value });
    el.allDayTime.value = s.allDayReminderTime;
    say(`All-day items now remind at ${s.allDayReminderTime}.`);
  }));
  el.snooze.addEventListener('change', guard(async () => {
    const s = await store.updateSettings({ snoozeMin: Number(el.snooze.value) });
    say(`Snooze is now ${s.snoozeMin} minutes.`);
  }));

  el.exportBtn.addEventListener('click', guard(async () => {
    const d = now();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `dayline-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    download(name, await store.exportJson());
    say(`Exported ${state.items.length} item${state.items.length === 1 ? '' : 's'} and ${state.categories.length} section${state.categories.length === 1 ? '' : 's'}.`);
  }));

  el.importBtn.addEventListener('click', guard(async () => {
    const file = el.importFile.files?.[0];
    if (!file) return say('Choose a backup file first.', { error: true });
    if (file.size > MAX_IMPORT_CHARS) return say('That file is too large to be a Dayline backup.', { error: true });
    const mode = doc.querySelector('input[name=mode]:checked').value;
    if (mode === 'replace' && !confirmReplace('Replace everything with the contents of this file? Your current items, sections and settings will be overwritten.')) return undefined;
    const r = await store.importJson(await file.text(), { mode });
    el.importFile.value = '';
    await refresh();
    const parts = [
      `${r.added} added`, `${r.updated} updated`, `${r.unchanged} unchanged`,
      r.categoriesAdded ? `${r.categoriesAdded} new section${r.categoriesAdded === 1 ? '' : 's'}` : null,
      r.skipped ? `${r.skipped} skipped` : null,
    ].filter(Boolean);
    say(`Import finished: ${parts.join(', ')}.`, { details: r.errors });
    return undefined;
  }));

  const ready = load().then(render);
  return { ready, refresh };
}
