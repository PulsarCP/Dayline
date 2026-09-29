# Dayline

A small, private Chrome extension for schedules, events and reminders.
Everything is stored locally in `chrome.storage.local`. There is no server, no account and no tracking.

## Status

Phase 1 of 4 is done: the data layer. There is no real UI yet.

| Phase | Scope | State |
|---|---|---|
| 1 | Manifest, data model, storage, recurrence, reminder maths, quick-add parser, JSON export/import | done |
| 2 | Popup: quick-add, today view, mark done | next |
| 3 | Background worker: alarms, notifications (snooze / mark done), toolbar badge | |
| 4 | Full-page app: month calendar, "All" list incl. undated items, search and filters, dark/light, settings | |

## Load it in Chrome

1. Open `chrome://extensions`
2. Switch on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`)

After pulling changes, press the reload icon on the extension's card.

## Develop

Requires Node 20+ (tested on 22). No dependencies.

```
npm test
```

Library code in `src/lib/` is pure (no `chrome.*` calls) except the storage adapter in `store.js`, so it is fully testable in Node.

## Permissions

Only `storage`, `alarms` and `notifications`. No host permissions, no content scripts, no remote code.

## Data and backup

Use the export / import functions (UI in a later phase) to back up or move data. Exports are plain JSON. Imports are validated item by item.
