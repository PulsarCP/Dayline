import { createChromeBackend, createStore, STORAGE_KEY } from '../lib/store.js';
import { mountCalendar } from './mount.js';

const store = createStore(createChromeBackend());
const app = mountCalendar(document, store, {
  openOptions: () => chrome.runtime.openOptionsPage(),
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_KEY in changes) app.refresh();
});
