import { createChromeBackend, createStore, STORAGE_KEY } from '../lib/store.js';
import { mountPopup } from './app.js';

const store = createStore(createChromeBackend());
const app = mountPopup(document, store, {
  openOptions: () => chrome.runtime.openOptionsPage(),
});

// Keep the popup in sync if data changes elsewhere (another window, the service worker).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_KEY in changes) app.refresh();
});
