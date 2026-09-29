# CURRENT_STATE

Handoff for the next phase's chat. Updated at the end of **Phase 1 (data layer)**.

Repo: https://github.com/PulsarCP/Dayline (branch `main`). Plain JavaScript ES modules, Manifest V3, no build step, no runtime dependencies. Tests: `npm test` (Node built-in runner).

## Decisions so far

- Name: **Dayline**. Chrome only, loaded unpacked, no Web Store. English UI. No sync in v1.
- Dates are local `"YYYY-MM-DD"` strings, times are `"HH:MM"` strings. No timestamps for scheduling, so no timezone/DST shifting.
- `date: null` means a general / undated item. Undated items cannot fire reminders.
- All-day items (date but no time) count as `settings.allDayReminderTime` (default `09:00`) for reminders.
- Recurring items are completed per occurrence via `completedDates`, one-off items use `done`.
- Permissions: `storage`, `alarms`, `notifications` only.
- v2 backlog (remind Daniel): categories/colors/tags, priority, subtasks, `chrome.storage.sync`, keyboard shortcuts, right-click "Add to schedule", `.ics` export, daily agenda notification, undo.

## Module interface (`src/lib/`)

### `dates.js`
`pad`, `toDateStr(Date)`, `parseDateStr(str) -> Date|null`, `isValidDateStr`, `isValidTimeStr`, `timeToMinutes`, `timeStrOf(Date)`, `addDays(str, n)`, `addMonths(str, n)` (clamps), `daysInMonth(y, m0)`, `diffDays(a, b)`, `weekdayOf(str)` (0 = Sunday), `combine(dateStr, timeStr) -> Date`.

### `recurrence.js`
Rule: `{ freq: 'daily'|'weekly'|'monthly', interval, weekdays?: number[], until?: 'YYYY-MM-DD' }`.
`normalizeRecurrence(rule) -> rule|null` (throws on invalid), `occurrencesBetween(item, from, to) -> string[]` (window capped at `MAX_SPAN_DAYS` = 800), `nextOccurrence(item, after, {includeAfter}) -> string|null`, `FREQS`.

### `model.js`
`normalizeItem(raw, now?) -> item` (throws on invalid; builds a fresh object from known fields only), `isDoneOn(item, date)`, `normalizeSettings`, `DEFAULT_SETTINGS`, `LIMITS`, `TYPES`.

Item: `{ id, title, notes, type: 'task'|'event', date, time, endTime, recurrence, reminders: [{offsetMin}], done, doneAt, completedDates, createdAt, updatedAt }`.
Limits: title 200, notes 2000, 10 reminders per item, offsets up to 60 days, 5000 items.

### `store.js`
`createStore(backend, {now, newId, useLocks}) ->` async API:
`list()`, `get(id)`, `add(input)`, `update(id, patch)` (patchable: title, notes, type, date, time, endTime, recurrence, reminders), `setDone(id, done, occurrenceDate?)` (recurring items require `occurrenceDate`), `remove(id)`, `getSettings()`, `updateSettings(patch)`, `exportJson()`, `importJson(text, {mode: 'merge'|'replace'}) -> {added, updated, unchanged, skipped, errors}`.
Backends: `createChromeBackend(area?)` (wraps `chrome.storage.local`), `createMemoryBackend(delayMs?)` (tests).
All writes are serialised (`navigator.locks` when present, else an in-process queue). Returned objects are copies.
Storage key: `dayline:v1`. Export format: `{ app: 'dayline', formatVersion: 1, exportedAt, settings, items }`.

### `reminders.js`
`upcomingReminders(items, now: Date, {horizonDays = 14, limit = 200, allDayTime}) -> [{itemId, date, reminderId, fireAt}]`, `occurrenceStart`, `alarmName({itemId, date, reminderId})` / `parseAlarmName(name)` (format `rem|itemId|date|reminderId`), `isOverdue(item, now)`, `badgeCount(items, now)`.

### `parser.js`
`parseQuickAdd(text, now = new Date()) -> { title, date, time, recurrence, matched: [{kind, text}] }`. Supported phrases are listed at the top of the file. DD/MM date order. Weekday names mean the next such day strictly after today. A bare "at 5" is not parsed.

## Not built yet

- `src/background.js` is an empty placeholder; `src/popup/popup.html` is a static stub. No icons.
- Nothing calls `chrome.alarms` / `chrome.notifications` / `chrome.action.setBadgeText` yet.
- No UI for export/import.

## Testing status

69 tests, all pass under `TZ=Europe/Rome`, `America/New_York`, `UTC`, `Pacific/Auckland`.

Untested here (no browser available in the build environment):
- Loading the extension in real Chrome (the manifest is only validated structurally in `tests/manifest.test.js`).
- The `navigator.locks` write path (Node 22 lacks it; that test is skipped).
- The real `chrome.storage.local` behaviour (only a fake area with the same shape is tested).

## Things to keep in mind for phase 2+

- Render every user-supplied string with `textContent`, never `innerHTML` (titles and notes come from the user and from imported files).
- MV3 service workers are killed when idle: never use `setTimeout` for reminders; re-derive alarms from storage on startup, on install and after every write.
- Recurring items: missed past occurrences are intentionally not counted in the badge and not flagged overdue.
