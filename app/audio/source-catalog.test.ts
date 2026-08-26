import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHORD_PROGRESSIONS,
  DEFAULT_SOURCE_CONFIG,
  GUITAR_VOICES,
  PERFORMANCE_SPECS,
  makeSourceConfig,
  normalizeSourceConfig,
  sourceConfigKey,
} from './source-catalog.ts';
import { getSourceEvents, synthesizeSourceChannels } from './audio-core.ts';

test('clean input catalog separates guitar, performance and chord choices', () => {
  assert.ok(GUITAR_VOICES.length >= 4);
  assert.ok(PERFORMANCE_SPECS.length >= 3);
  assert.ok(CHORD_PROGRESSIONS.length >= 4);
  assert.equal(new Set(GUITAR_VOICES.map((voice) => voice.id)).size, GUITAR_VOICES.length);
  assert.equal(new Set(CHORD_PROGRESSIONS.map((progression) => progression.id)).size, CHORD_PROGRESSIONS.length);
});

test('legacy source values migrate to the expanded source config', () => {
  assert.deepEqual(normalizeSourceConfig('arpeggio'), {
    ...DEFAULT_SOURCE_CONFIG,
    performance: 'arpeggio',
  });
  assert.deepEqual(normalizeSourceConfig({ guitar: 'humbucker', performance: 'lead', progression: 'minor-drift' }), {
    guitar: 'humbucker',
    performance: 'lead',
    progression: 'minor-drift',
  });
});

test('different chord choices and guitar voices produce distinct deterministic performances', () => {
  const open = makeSourceConfig('chords', 'single-neck', 'dream-open');
  const minor = makeSourceConfig('chords', 'single-neck', 'minor-drift');
  assert.notDeepEqual(getSourceEvents(open), getSourceEvents(minor));

  const neck = synthesizeSourceChannels(open, 8_000);
  const bridge = synthesizeSourceChannels(makeSourceConfig('chords', 'single-bridge', 'dream-open'), 8_000);
  const neckAgain = synthesizeSourceChannels(open, 8_000);
  assert.deepEqual(neck[0].slice(0, 2048), neckAgain[0].slice(0, 2048));
  assert.notDeepEqual(neck[0].slice(0, 2048), bridge[0].slice(0, 2048));
  assert.notEqual(sourceConfigKey(open), sourceConfigKey(minor));
});
