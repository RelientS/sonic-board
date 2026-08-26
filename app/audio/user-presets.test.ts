import assert from 'node:assert/strict';
import test from 'node:test';

import { captureUserPreset, instantiateUserPreset, parseUserPresets } from '../effects/user-presets.ts';

test('captureUserPreset stores portable chain settings without runtime instance ids', () => {
  const preset = captureUserPreset({
    name: '我的音墙',
    chain: [{ instanceId: 'wall-fuzz-173', specId: 'wall-fuzz' }],
    values: { 'wall-fuzz-173': { volume: 61, tone: 42, sustain: 80, mids: 58, attack: 20, gate: 10 } },
    bypassed: new Set(['wall-fuzz-173']),
    source: 'chords',
    output: 68,
  }, 'preset-1', 1234);

  assert.equal(preset.id, 'preset-1');
  assert.equal(preset.createdAt, 1234);
  assert.deepEqual(preset.chain[0], { specId: 'wall-fuzz', settings: { volume: 61, tone: 42, sustain: 80, mids: 58, attack: 20, gate: 10 }, bypassed: true });
});

test('instantiateUserPreset creates fresh runtime ids and restores bypass state', () => {
  const stored = {
    id: 'saved-1', name: 'Saved', createdAt: 12, source: 'lead' as const, output: 64,
    chain: [{ specId: 'rodent-dist', settings: { distortion: 72, filter: 48, volume: 58 }, bypassed: true }],
  };
  const first = instantiateUserPreset(stored);
  const second = instantiateUserPreset(stored);

  assert.notEqual(first.chain[0].instanceId, second.chain[0].instanceId);
  assert.deepEqual(first.bypassed, [first.chain[0].instanceId]);
  assert.equal(first.values[first.chain[0].instanceId].distortion, 72);
});

test('parseUserPresets rejects malformed storage and caps the library', () => {
  assert.deepEqual(parseUserPresets('not json'), []);
  assert.deepEqual(parseUserPresets(JSON.stringify([{ id: 1 }])), []);

  const valid = Array.from({ length: 30 }, (_, index) => ({
    id: `id-${index}`, name: `音色 ${index}`, createdAt: index, source: 'chords', output: 70,
    chain: [{ specId: 'blue-drive', settings: { level: 60, tone: 50, gain: 40 }, bypassed: false }],
  }));
  assert.equal(parseUserPresets(JSON.stringify(valid)).length, 24);
});
