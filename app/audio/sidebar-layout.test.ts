import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('the effect library exposes a dedicated scroll region', () => {
  assert.match(page, /className="library-browser effects-browser"/);
  assert.match(styles, /\.effects-browser\s+\.library-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.effects-browser\s*\{[^}]*grid-template-rows:[^;}]*minmax\(0,\s*1fr\)/s);
});

test('desktop workbench is viewport-bound while mobile remains document-flow', () => {
  assert.match(styles, /@media\s*\(min-width:\s*1081px\)[\s\S]*?\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.app-shell\s*\{[^}]*display:\s*block/s);
});

test('the output picker visibly identifies reference names as unofficial approximations', () => {
  assert.match(page, /经典名称仅用于说明参考对象/);
  assert.match(page, /className="model-method"/);
  assert.match(styles, /\.model-method\s*\{/);
});
