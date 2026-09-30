# Dayline

A small, private Chrome extension for schedules, events and reminders.
Everything is stored locally in `chrome.storage.local`. There is no server, no account and no tracking.

## Status

Phases 1 and 2 of 4 are done: the data layer and the popup. Reminders do not fire yet (phase 3).

| Phase | Scope | State |
|---|---|---|
| 1 | Manifest, data model, storage, recurrence, reminder maths, quick-add parser, JSON export/import | done |
| 2 | Popup: quick-add with live preview, Today / Upcoming / General, mark done, delete, overdue, dark/light, icons | done |
| 3 | Background worker: alarms, notifications (snooze / mark done), toolbar badge | next |
| 4 | Full-page app: month calendar, "All" list incl. undated items, search and filters, dark/light, settings | |

## Load it in Chrome

1. Open `chrome://extensions`
2. Switch on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`)

After pulling changes, press the reload icon on the extension's card.

## Develop

Requires Node 20+ (tested on 22). No dependencies.

```
npm test                         # unit tests
node tools/make-icons.mjs        # regenerate icons/
python3 tests/e2e/popup_drive.py # optional: drives the real popup in Chromium (needs Playwright)
```

Library code in `src/lib/` is pure (no `chrome.*` calls) except the storage adapter in `store.js`, so it is fully testable in Node.

## Permissions

Only `storage`, `alarms` and `notifications`. No host permissions, no content scripts, no remote code.

## Data and backup

Use the export / import functions (UI in a later phase) to back up or move data. Exports are plain JSON. Imports are validated item by item.
