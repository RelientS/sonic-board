import assert from 'node:assert/strict';
import test from 'node:test';

import { EFFECT_SPECS } from '../effects/catalog.ts';
import { SUPPORTED_EFFECT_IDS } from './audio-engine.ts';

test('the audio engine implements every effect exposed by the catalog', () => {
  assert.deepEqual([...SUPPORTED_EFFECT_IDS].sort(), EFFECT_SPECS.map((effect) => effect.id).sort());
});
