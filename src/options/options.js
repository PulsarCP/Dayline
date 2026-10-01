import { createChromeBackend, createStore, STORAGE_KEY } from '../lib/store.js';
import { mountOptions } from './app.js';

const store = createStore(createChromeBackend());
const app = mountOptions(document, store, { version: chrome.runtime.getManifest().version });

// Pick up changes made elsewhere (popup, quick-add tags), unless the user is typing here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEY in changes)) return;
  const active = document.activeElement;
  if (active && active.closest('#sections')) return;
  app.refresh();
});
