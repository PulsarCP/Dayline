# CURRENT_STATE

Handoff for the next chat. Updated after **Phase 4** (calendar page, All list with search/filters, multi-weekday and hourly repeats) and a round of improvements after Daniel used it for a few days (per-slot done and restart for hourly items, `checkable` / `showOnCalendar` item options, weekday ranges, popup always opens on Today, no visible popup scrollbar, multi-day select toggle).

Repo: https://github.com/PulsarCP/Dayline (branch `main`). Plain JavaScript ES modules, Manifest V3 (v0.4.0), no build step, no runtime dependencies. Tests: `npm test` (Node built-in runner, ~140 tests). End-to-end: `python3 tests/e2e/e2e.py` (Playwright + Chromium).

## Decisions so far

- Name **Dayline**. Chrome only, loaded unpacked, no Web Store. English UI. No sync in v1.
- Dates are local `"YYYY-MM-DD"` strings, times `"HH:MM"`. No timestamps for scheduling, so no timezone/DST shifting.
- `date: null` = general / undated item. Undated items cannot have reminders.
- All-day items (date, no time) count as `settings.allDayReminderTime` (default `09:00`) for reminders.
- Recurring items complete per occurrence (`completedDates`); one-off items use `done`.
- A multi-day item has `endDate` after `date`. It never repeats (a recurrence drops `endDate`). It shows on every day of the span; reminders fire before its first day only; it is overdue after its last day.
- Sections are user-defined (`{id, name, color}`), max 20, unique names (case-insensitive), colours are names from `COLORS` (never CSS). Deleting a section keeps its items (they become unsectioned).
- Permissions: `storage`, `alarms`, `notifications` only.
- Daniel wants these v2 items remembered and raised later: priority levels, subtasks/checklists, `chrome.storage.sync`, keyboard shortcuts, right-click "Add to schedule", `.ics` export, daily agenda notification, undo. (Sections were pulled into v1.)

## Module interfaces

### `src/lib/dates.js`
`pad`, `toDateStr(Date)`, `parseDateStr(str) -> Date|null`, `isValidDateStr`, `isValidTimeStr`, `timeToMinutes`, `timeStrOf(Date)`, `addDays`, `addMonths` (clamps), `daysInMonth`, `diffDays(a, b)`, `weekdayOf` (0 = Sunday), `combine(dateStr, timeStr) -> Date`.

### `src/lib/recurrence.js`
Rule: `{freq: 'hourly'|'daily'|'weekly'|'monthly', interval, weekdays?, until?}`. Hourly (done per slot: `completedDates` holds `YYYY-MM-DD@HH:MM`; `hourlyState(item, now)` gives the row Today shows; `store.restartHourly(id)` re-anchors at now and ticks that slot): interval 1..23, needs a start time (model throws otherwise); the occurrence is the day, `slotsOn(item, date)` lists the clock times (continuous from the first start, so they shift per day when 24 is not a multiple). Reminder ids for hourly are `offset@HH:MM` (`splitReminderId`); done/snooze are per day. `normalizeRecurrence`, `occurrencesBetween(item, from, to)` (window capped at 800 days; a one-off item yields only its own `date`), `nextOccurrence`.

### `src/lib/model.js`
`normalizeItem(raw, now?)` (throws on invalid; builds a fresh object from known fields), `normalizeCategory`, `normalizeSettings`, `isDoneOn(item, date)`, `lastDayOf(item)`, `LIMITS`, `TYPES`, `COLORS`, `SNOOZE_CHOICES`, `DEFAULT_SETTINGS`.

Item: `{id, title, notes, type: 'task'|'event', date, endDate, time, endTime, recurrence, checkable (false = no done checkbox; never overdue, not counted, vanishes after its day), showOnCalendar (false = not on the month grid; still in the day panel), categoryId, reminders: [{offsetMin}], done, doneAt, completedDates, createdAt, updatedAt}`. `endTime` must be after `time` only for single-day items.
Settings: `{allDayReminderTime: '09:00', defaultReminderMin: 10|null, snoozeMin: 5|10|15|30|60}`.
Limits: title 200, notes 2000, 10 reminders, offsets up to 60 days, 5000 items, 20 sections, section name 30, span up to 366 days.

### `src/lib/store.js`
`createStore(backend, {now, newId, useLocks})` async API: `list`, `getState` (items + categories + settings in one read), `get`, `add`, `update` (patchable: title, notes, type, date, endDate, time, endTime, recurrence, categoryId, reminders; moving `date` keeps a span's length), `setDone(id, done, occurrenceDate?)`, `remove`, `listCategories`, `addCategory`, `updateCategory`, `removeCategory -> {removed, itemsCleared}`, `getSettings`, `updateSettings`, `exportJson`, `importJson(text, {mode: 'merge'|'replace'}) -> {added, updated, unchanged, skipped, categoriesAdded, errors}`.
Backends: `createChromeBackend(area?)`, `createMemoryBackend(delayMs?)`. Writes are serialised (`navigator.locks`, else a promise queue). Storage key `dayline:v1`; data without `categories` (older versions) loads fine. Export: `{app: 'dayline', formatVersion: 1, exportedAt, settings, categories, items}`. Merge import matches sections by id, then by name, and remaps items.

### `src/lib/parser.js`
`parseQuickAdd(text, now) -> {title, date, endDate, time, recurrence, categoryTag, matched}`. Understands: today/tomorrow/tonight/day after tomorrow, weekday names (next such day after today), `5 oct`, `oct 5 2027`, `15/12` (DD/MM), ISO dates, times (`15:00`, `3pm`, `noon`), `in 2 hours/days/weeks`, repeats (`daily`, `every 2 weeks`, `every weekday`, `every other friday`), ranges (`7-8 october`, `oct 7-9`, `from 7 to 9 oct`, `30 oct - 2 nov`, `dec 30 - jan 2`, ISO `to` ISO), `for N days` (2..60), `#section` (first tag wins, must start with a letter). Reversed or same-day ranges are not ranges.

### `src/lib/reminders.js`
`remindersBetween(items, fromMs, toMs)`, `upcomingReminders(items, now, {horizonDays, limit})`, `missedReminders(items, now, {lookbackMin})`, `isStillRelevant`, `occurrenceStart`, `alarmName` / `parseAlarmName` (`rem|itemId|date|offsetMin`), `isOverdue`, `badgeCount`.

### `src/lib/views.js`
`buildViews(items, now, {showDone, category: 'all'|'none'|id}) -> {today: {overdue, rows, completed}, upcoming: {groups, later}, general, counts}`. Rows: `{item, date, done, overdue, span: {index, total}|null}`. Upcoming = next 7 days (`later` capped at 50); `counts.upcoming` counts distinct items. Also `categoryOf`, `formatDate`, `formatDay`, `formatRange`, `formatWhen`, `spanLabel`, `repeatLabel`, `offsetLabel`, `remindersSummary`, `REMINDER_CHOICES`, `remindersFor`.

### `src/lib/scheduler.js`
`createScheduler({api, store, backend, now})` where `api` is the `chrome` object (needs `alarms`, `notifications`, `action`, optional `runtime.getURL`). Returns `sync`, `requestSync`, `boot` (catch-up then sync), `handleAlarm`, `handleButton(id, index)` (0 = Snooze, 1 = Mark done), `handleClick`, `updateBadge`, `whenIdle`. All operations run one at a time. Derives everything from storage (the service worker may be killed at any time). Bookkeeping keys: `dayline:snoozes`, `dayline:fired`. Alarms: `rem|...` per upcoming reminder (14 days, max 300), `snz|itemId|date` per pending snooze, `dl-tick` (hourly resync), `dl-midnight` (badge refresh). Catch-up: reminders due in the last 12 h that are still relevant, max 5 notifications plus one summary.

### `src/background.js`
Registers listeners synchronously and delegates to the scheduler. Storage changes trigger a debounced sync.

### UI
- `src/ui/theme.css` (variables, light/dark, controls, section colours), `src/ui/dom.js` (`createH`, `createIcon`), `src/ui/item-form.js` (`createItemForm(doc, {item, categories, onSave, onCancel, onDelete})`, reusable for the calendar page).
- `src/popup/` (`app.js` has `mountPopup(document, store, {now, openOptions})`): quick-add with live preview chips, section select, Today / Upcoming / General tabs, section filter chips (shown once sections exist), edit view (click a row or the pencil), two-step delete. Tab, filter and "show completed" are remembered in `localStorage` (convenience only).
- `src/options/` (`app.js` has `mountOptions(document, store, {version, download, confirmReplace, now})`): sections (add, rename, recolour, delete), default reminder, all-day reminder time, snooze length, export/import. Opened as a full tab (`options_ui.open_in_tab`) because file pickers can close an extension popup.

### `src/lib/calendar.js` and `src/app/`
`monthGrid(year, month0, weekStart)`, `dayRows(items, from, to, now)` (Map date -> rows), `selectDay(state, date, {ctrl, shift})`, `selectionTarget(selected)` (first day; last day only for an unbroken run), `filterAll(items, {query, status, category, when, from, to}, now)`, `monthTitle`. `src/app/mount.js` has `mountCalendar(document, store, {now, openOptions})`; page `src/app/app.html` (opened with `chrome.tabs.create` from the popup's calendar button; no extra permission). The panel quick-add uses typed dates, otherwise the selected day(s). The All list shows a repeating series once (no tick box).
Popup: the "No section" filter chip was removed (the add/edit select still has "No section").

## Lessons learned (keep)

- **Notification `iconUrl` must be a full extension URL** (`chrome.runtime.getURL(...)`). A relative path resolves against the calling script (`src/...`) and Chrome rejects the whole notification. The unit tests with a fake could not catch this; the e2e run did.
- Never pass `null` to `Element.replaceChildren`: it inserts the text "null".
- Take dark-mode screenshots after the 150 ms colour transition has finished.
- `import()` is not allowed in a service worker, so e2e tests drive the scheduler from an extension page instead.

## Testing status

- 158 unit tests (157 pass, 1 skipped: `navigator.locks` path, Node 22 lacks it) pass under `TZ=Europe/Rome`, `America/New_York`, `Pacific/Auckland`, `UTC`.
- `tests/e2e/e2e.py` (headless Chromium 141, extension loaded unpacked): all checks pass. Covers quick-add ranges and `#tags`, sections and filters, edit form, options page (sections, settings, export, merge/replace import, corrupt file), real worker: alarm created after adding an item, notification shown, Snooze, snoozed reminder returning, Mark done clearing alarms and badge, startup catch-up, no console errors.

Not verified (needs Daniel's real Chrome): how the OS actually displays notifications (Windows/macOS/Linux settings, Focus modes), `requireInteraction` behaviour per OS, popup size and focus in headed Chrome, behaviour after a real browser restart (alarm persistence is handled by re-deriving on startup, but only simulated), and the `navigator.locks` write path.

## Known limitations / ideas

- Chrome allows two notification buttons, so only one snooze length (configurable in settings). Other lengths would need a snooze picker in the popup.
- A multi-day item cannot also repeat.
- A multi-day item appears once per day in Upcoming (7 days max), counted once.
- Recurring items: missed past occurrences are not flagged overdue and not counted in the badge (by design).
- Editing a repeating item edits the whole series.
- Hourly repeats: Mark done on a notification ticks that slot; the calendar page lists the series once per day and has no tick box for it (tick in the popup).
- Calendar page: multi-day items are chips on each day (no continuous bars); Monday-first weeks.
- Rendering rule: every user-supplied string goes through `textContent`/text nodes, never `innerHTML` (an `<img onerror>` title is verified inert).

## Next

(v2 list still on hold at Daniel's request.) Remind Daniel of the v2 list above (priority levels, subtasks, `chrome.storage.sync`, keyboard shortcuts, right-click "Add to schedule", `.ics` export, daily agenda notification, undo). Possible polish: continuous multi-day bars, drag to move, per-slot completion for hourly items.
