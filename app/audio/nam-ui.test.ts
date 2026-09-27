import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../studio/page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('the Fuzz War card imports and removes an A1 NAM from private browser storage', () => {
  assert.match(page, /createBrowserNamModelRepository/);
  assert.match(page, /parseNamModel/);
  assert.match(page, /createNamModelRecord/);
  assert.match(page, /accept="\.nam"/);
  assert.match(page, /本机|本地/);
  assert.match(page, /A1 Legacy/);
  assert.match(page, /repository\.save/);
  assert.match(page, /repository\.remove/);
});

test('private NAM payloads are included in audio configuration but not user presets', () => {
  assert.match(page, /const \[namModels, setNamModels\]/);
  assert.match(page, /namModels,\s*ampModel: ampModel\?\.id === amp\.ampId \? ampModel : undefined,\s*\}\), \[chain/);
  // Private amp captures are never written into presets either.
  assert.doesNotMatch(page, /captureUserPreset\([\s\S]{0,300}ampModel/);
  assert.doesNotMatch(page, /captureUserPreset\([\s\S]{0,300}namModels/);
});

test('local model controls remain usable on a narrow mobile library card', () => {
  assert.match(styles, /\.nam-local-actions/);
  assert.match(styles, /@media \(max-width:/);
  assert.match(styles, /\.nam-local-actions[\s\S]{0,800}(flex-wrap|grid-template-columns)/);
});

test('desktop NAM cards expand to contain their local model controls', () => {
  assert.match(styles, /\.library-item\.has-nam\s*\{[^}]*height:\s*max-content/s);
});
