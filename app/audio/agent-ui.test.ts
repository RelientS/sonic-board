import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('workbench exposes an accessible tone agent and clean input picker', () => {
  assert.match(page, /function ToneAgentDialog/);
  assert.match(page, /function SourcePickerDialog/);
  assert.match(page, /className="agent-open-button"/);
  assert.match(page, /aria-label="选择清音输入"/);
  assert.match(page, /生成并应用/);
});

test('agent and source dialogs adapt to mobile sheets', () => {
  assert.match(styles, /\.agent-dialog/);
  assert.match(styles, /\.source-picker-dialog/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.agent-dialog[^}]*position:\s*fixed/s);
});
