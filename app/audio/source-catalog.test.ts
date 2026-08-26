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
  assert.ok(PERFORMANCE_SPECS.length >= 6);
  assert.ok(CHORD_PROGRESSIONS.length >= 4);
  assert.equal(new Set(GUITAR_VOICES.map((voice) => voice.id)).size, GUITAR_VOICES.length);
  assert.equal(new Set(CHORD_PROGRESSIONS.map((progression) => progression.id)).size, CHORD_PROGRESSIONS.length);
  assert.deepEqual(
    PERFORMANCE_SPECS.filter((performance) => performance.id.includes('strum')).map((performance) => performance.id),
    ['eighth-strum', 'syncopated-strum', 'wall-strum'],
  );
  assert.ok(PERFORMANCE_SPECS.every((performance) => performance.description.length >= 8));
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

test('rhythm choices create repeated down-up strums with distinct accents', () => {
  const single = getSourceEvents(makeSourceConfig('chords', 'single-neck', 'dream-open'));
  const eighths = getSourceEvents(makeSourceConfig('eighth-strum', 'single-neck', 'dream-open'));
  const syncopated = getSourceEvents(makeSourceConfig('syncopated-strum', 'single-neck', 'dream-open'));
  const wall = getSourceEvents(makeSourceConfig('wall-strum', 'single-neck', 'dream-open'));

  assert.equal(single.length, 16);
  assert.equal(eighths.length, 64);
  assert.equal(syncopated.length, 80);
  assert.equal(wall.length, 32);
  assert.deepEqual(eighths.slice(0, 4).map((event) => event.frequency), [110, 164.81, 220, 246.94]);
  assert.deepEqual(eighths.slice(4, 8).map((event) => event.frequency), [246.94, 220, 164.81, 110]);
  assert.ok(eighths[0].velocity > eighths[4].velocity);
  assert.notDeepEqual(eighths.map((event) => event.time), syncopated.map((event) => event.time));
  assert.ok([...eighths, ...syncopated, ...wall].every((event) => event.time < 6.1 && event.duration > 0));
});
