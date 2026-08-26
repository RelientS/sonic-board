import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AMP_SPECS, CAB_SPECS } from '../amps/catalog.ts';
import { EFFECT_SPECS } from '../effects/catalog.ts';
import { SUPPORTED_AMP_IDS, SUPPORTED_CAB_IDS, SUPPORTED_EFFECT_IDS } from './audio-engine.ts';

const engineSource = readFileSync(new URL('./audio-engine.ts', import.meta.url), 'utf8');

test('the audio engine implements every effect exposed by the catalog', () => {
  assert.deepEqual([...SUPPORTED_EFFECT_IDS].sort(), EFFECT_SPECS.map((effect) => effect.id).sort());
});

test('the audio engine implements every amp and cabinet exposed by the catalog', () => {
  assert.deepEqual([...SUPPORTED_AMP_IDS].sort(), AMP_SPECS.map((amp) => amp.id).sort());
  assert.deepEqual([...SUPPORTED_CAB_IDS].sort(), CAB_SPECS.map((cab) => cab.id).sort());
});

test('the audio engine renders real guitar samples and keeps synthesis only as fallback', () => {
  assert.match(engineSource, /renderSampledSourceBuffer/);
  assert.match(engineSource, /catch[\s\S]*synthesizeSourceChannels/);
});
