// MV3 service worker. Listeners are registered synchronously at the top level (required,
// or Chrome will not wake the worker for those events). All logic lives in lib/scheduler.js.

import { createScheduler } from './lib/scheduler.js';
import { createChromeBackend, createStore, STORAGE_KEY } from './lib/store.js';

const backend = createChromeBackend();
const store = createStore(backend);
const scheduler = createScheduler({ api: chrome, store, backend });

const safe = (fn) => (...args) => {
  Promise.resolve(fn(...args)).catch((e) => console.error('[dayline]', e));
};

chrome.runtime.onInstalled.addListener(safe(() => scheduler.boot()));
chrome.runtime.onStartup.addListener(safe(() => scheduler.boot()));
chrome.alarms.onAlarm.addListener(safe((alarm) => scheduler.handleAlarm(alarm)));
chrome.notifications.onButtonClicked.addListener(safe((id, i) => scheduler.handleButton(id, i)));
chrome.notifications.onClicked.addListener(safe((id) => scheduler.handleClick(id)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_KEY in changes) scheduler.requestSync();
});
