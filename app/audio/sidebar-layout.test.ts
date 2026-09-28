import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { studioSource, studioStyles } from './studio-sources.ts';

const page = studioSource;
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');
const rig = readFileSync(new URL('../studio/Rig.tsx', import.meta.url), 'utf8');

test('the pedal picker keeps its results in a dedicated scroll region', () => {
  assert.match(page, /className="picker-results" role="listbox"/);
  assert.match(studioStyles, /\.picker-results \{[^}]*overflow-y: auto/);
  assert.match(studioStyles, /\.picker-sheet \{ grid-template-rows:[^;}]*minmax\(0, 1fr\)/);
});

test('desktop studio is viewport-bound while phones remain document-flow', () => {
  assert.match(studioStyles, /^\.studio \{[^}]*height: 100dvh;[^}]*overflow: hidden;/m);
  assert.match(studioStyles, /@media \(max-width: 720px\)[\s\S]*?\.studio \{ display: block;/);
  // The board never scrolls sideways: it is laid out to fit.
  assert.match(studioStyles, /\.board-stage \{[^}]*overflow: hidden;/);
});

test('the rig deck visibly identifies how each amp and cab is modelled', () => {
  assert.match(page, /经典名称仅用于说明参考对象/);
  assert.match(rig, /<span className="model-method">\{amp\.modeling\}<\/span>/);
  assert.match(rig, /<span className="model-method">\{cab\.modeling\}<\/span>/);
  // CC BY credit for measured IRs stays visible wherever the cab is shown.
  assert.match(rig, /\{cab\.ir && <p className="model-credit">\{cab\.ir\.credit\}<\/p>\}/);
  assert.match(styles, /\.model-method\s*\{/);
});

test('the effect library presents pedals uniformly without per-model engine badges', () => {
  assert.match(page, /模型通过自动门禁/);
  assert.match(page, /待真机验证/);
  assert.match(page, /github\.com\/RelientS\/sonic-board/);
  assert.doesNotMatch(page, /FidelityChip|fidelity-chip|候选暂停|旧引擎/);
  assert.doesNotMatch(styles, /\.fidelity-chip/);
});
