import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EFFECT_SPECS,
  FACTORY_PRESETS,
  STYLE_TAGS,
  STYLE_TAG_LABELS,
  getEffectSearchText,
  getPresetSearchText,
} from '../effects/catalog.ts';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('effect discovery text matches English and Chinese style terms', () => {
  for (const tag of STYLE_TAGS) {
    const EnglishMatches = EFFECT_SPECS.filter((effect) => getEffectSearchText(effect).toLowerCase().includes(tag));
    const ChineseMatches = EFFECT_SPECS.filter((effect) => getEffectSearchText(effect).includes(STYLE_TAG_LABELS[tag]));
    assert.ok(EnglishMatches.length > 0, `missing English effect discovery for ${tag}`);
    assert.ok(ChineseMatches.length > 0, `missing Chinese effect discovery for ${STYLE_TAG_LABELS[tag]}`);
  }
});

test('every style filter has a discoverable factory preset', () => {
  for (const tag of STYLE_TAGS) {
    const matches = FACTORY_PRESETS.filter((preset) => preset.styleTags?.includes(tag));
    assert.ok(matches.length > 0, `missing preset for ${tag}`);
    assert.ok(matches.every((preset) => getPresetSearchText(preset).includes(STYLE_TAG_LABELS[tag])));
  }
});

test('workbench intersects legacy effect query and category with style metadata', () => {
  assert.match(page, /getEffectSearchText\(spec\)\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(page, /const categoryMatches = category === 'All' \|\| spec\.category === category/);
  assert.match(page, /const styleMatches = styleFilter === 'All' \|\| spec\.styleTags\?\.includes\(styleFilter\)/);
  assert.match(page, /return categoryMatches && styleMatches && queryMatches/);
});

test('style controls filter effects and presets and preset cards expose their tags', () => {
  assert.match(page, /function StyleFilters/);
  assert.match(page, /STYLE_TAGS\.map\(\(tag\) =>/);
  assert.match(page, /STYLE_TAG_LABELS\[tag\]/);
  assert.equal(page.match(/<StyleFilters value=\{styleFilter\} onChange=\{setStyleFilter\} \/>/g)?.length, 2);
  assert.match(page, /getPresetSearchText\(preset\)\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(page, /className="preset-style-tags"/);
  assert.match(page, /preset\.styleTags\?\.map\(\(tag\) =>/);
});

test('style controls remain compact, horizontally scrollable, and touch sized', () => {
  assert.match(styles, /\.style-filters[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s);
  assert.match(styles, /\.style-filters button[^}]*min-height:\s*38px/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.style-filters button[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.preset-card \.preset-style-tags span/);
});
