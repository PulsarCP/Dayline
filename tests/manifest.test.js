import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('manifest is MV3 and every referenced file exists', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(existsSync(join(root, manifest.background.service_worker)));
  assert.ok(existsSync(join(root, manifest.action.default_popup)));
  assert.ok(existsSync(join(root, manifest.options_ui.page)));
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.ok(existsSync(join(root, 'src/app/app.html')));
  for (const size of Object.values(manifest.icons)) assert.ok(existsSync(join(root, size)));
});

test('permissions stay minimal and there is no remote access', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.doesNotMatch(JSON.stringify(manifest.content_security_policy), /unsafe|https?:/);
});

test('library code never touches chrome.* directly except the storage adapter', () => {
  for (const f of ['dates', 'recurrence', 'model', 'reminders', 'parser', 'views', 'scheduler', 'calendar']) {
    const src = readFileSync(join(root, 'src/lib', `${f}.js`), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\bchrome\./, `${f}.js must stay pure`);
  }
});
