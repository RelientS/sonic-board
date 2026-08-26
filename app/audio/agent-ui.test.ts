import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('workbench exposes an accessible tone agent and clean input picker', () => {
  assert.match(page, /<ToneAgentDock/);
  assert.match(page, /captureToneAgentBoard/);
  assert.match(page, /function SourcePickerDialog/);
  assert.match(page, /className=\{'agent-open-button'/);
  assert.match(page, /aria-label=\{agentOpen \? '关闭音色 Agent' : '打开音色 Agent'\}/);
  assert.match(page, /aria-label="选择清音输入"/);
  assert.match(page, /真实采样 · 未处理 DI · CC0/);
  assert.match(page, /FreePats Direct DI/);
  assert.match(page, /performance\.description/);
  assert.doesNotMatch(page, /Black & Green Guitars/);
});

test('agent uses a persistent desktop dock and a mobile full-height workspace', () => {
  assert.match(styles, /\.tone-agent-dock[^}]*position:\s*fixed/s);
  assert.match(styles, /\.tone-agent-thread[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.source-picker-dialog/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.tone-agent-dock[^}]*inset:\s*0/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.tone-agent-composer textarea[^}]*font-size:\s*16px/s);
});
