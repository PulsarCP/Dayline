# Dayline

A small, private Chrome extension for schedules, events and reminders.
Everything is stored locally in `chrome.storage.local`. There is no server, no account and no tracking.

## What it does

- **Quick-add** with natural language and a live preview: `dentist tomorrow 3pm`, `gym every monday 7am`, `7-8 october Job Fair`, `trip tomorrow for 3 days`, `report friday #work`, `gym every thursday and friday 7am`, `drink water every 5 hours`.
- **Today / Upcoming / General** views. General holds items without a date.
- **Multi-day events**, shown on every day they span ("Day 2 of 3").
- **Your own sections** (Work, Study, ...) with colours. Filter by section, or type `#work` when adding.
- **Mark done**, per occurrence for repeating items. Overdue items stay visible, in red.
- **Repeating items**: every N hours, daily, weekly (one or several weekdays), monthly, with an optional end date. An hourly repeat counts continuously from its start time (09:00 every 5 h gives 09, 14, 19, 00, 05, ...), reminds at each slot, and is completed per day.
- **Calendar page** (calendar icon in the popup): month grid, click days to select them (Ctrl/Cmd adds, Shift selects a range), see what is on them, add an item on the selected day(s), edit or tick items. An **All** tab lists everything, including undated items, with search and filters (status, section, when, date range).
- **Reminders**: several per item. Notifications have **Snooze** and **Mark done** buttons, reminders missed while Chrome was closed are shown on the next start, and the toolbar badge counts what is open today.
- **Edit** any item (click it), **export / import** a JSON backup, light and dark themes.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Data model, storage, recurrence, reminder maths, quick-add parser, JSON export/import | done |
| 2 | Popup: quick-add, Today / Upcoming / General, mark done, delete, overdue, dark/light, icons | done |
| 3 | Background worker: alarms, notifications (snooze / mark done), catch-up, toolbar badge. Also: multi-day events, sections, item editing, options page | done |
| 4 | Full-page app: month calendar with selectable days, "All" list with search and filters; multi-weekday and hourly repeats | done |

## Load it in Chrome

1. Open `chrome://extensions`
2. Switch on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`)

After pulling changes, press the reload icon on the extension's card.
Settings, sections and backup live on the options page (the sliders icon in the popup, or the extension's "Details > Extension options").

Notifications also need to be allowed for Chrome in your operating system's settings.

## Develop

Requires Node 20+ (tested on 22). No dependencies.

```
npm test                    # unit tests (about 150)
node tools/make-icons.mjs   # regenerate icons/
python3 tests/e2e/e2e.py    # optional: end-to-end run in real Chromium (needs Playwright)
```

The unit tests cover everything in `src/lib/`, including the scheduler against a fake `chrome` API. `tests/e2e/e2e.py` loads the extension unpacked and drives the popup, options page and background worker against the real `chrome.*` APIs.

Library code in `src/lib/` never touches `chrome.*` directly (the scheduler takes the API as a parameter; `store.js` has a small adapter), so it is testable in Node.

## Permissions

Only `storage`, `alarms` and `notifications`. No host permissions, no content scripts, no remote code.

## Data and backup

Use **Export backup** and **Import** on the options page to back up or move data. Exports are plain JSON. Imports are validated item by item and can merge into, or replace, what you have.
