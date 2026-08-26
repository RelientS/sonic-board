import assert from 'node:assert/strict';
import test from 'node:test';

import { captureUserPreset, instantiateUserPreset, parseUserPresets } from '../effects/user-presets.ts';
import { DEFAULT_SOURCE_CONFIG, makeSourceConfig } from './source-catalog.ts';

test('captureUserPreset stores portable chain settings without runtime instance ids', () => {
  const preset = captureUserPreset({
    name: '我的音墙',
    chain: [{ instanceId: 'wall-fuzz-173', specId: 'wall-fuzz', lane: 'B' }],
    values: { 'wall-fuzz-173': { volume: 61, tone: 42, sustain: 80, mids: 58, attack: 20, gate: 10 } },
    bypassed: new Set(['wall-fuzz-173']),
    source: makeSourceConfig('chords', 'humbucker', 'power-bloom'),
    output: 68,
    routing: { mode: 'parallel', blend: 62, spread: 78 },
    amp: {
      ampId: 'glass-120', cabId: 'open-2x12', bypassed: false,
      ampValues: { input: 50, gain: 22, bass: 48, mid: 54, treble: 62, presence: 57, master: 70 },
      cabValues: { position: 58, distance: 24, room: 12 },
    },
  }, 'preset-1', 1234);

  assert.equal(preset.id, 'preset-1');
  assert.equal(preset.createdAt, 1234);
  assert.deepEqual(preset.chain[0], { specId: 'wall-fuzz', lane: 'B', settings: { volume: 61, tone: 42, sustain: 80, mids: 58, attack: 20, gate: 10 }, bypassed: true });
  assert.deepEqual(preset.routing, { mode: 'parallel', blend: 62, spread: 78 });
  assert.equal(preset.amp.ampId, 'glass-120');
  assert.equal(preset.source.guitar, 'humbucker');
});

test('instantiateUserPreset creates fresh runtime ids and restores bypass state', () => {
  const stored = {
    id: 'saved-1', name: 'Saved', createdAt: 12, source: makeSourceConfig('lead', 'single-bridge', 'major-seven'), output: 64,
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

test('parseUserPresets migrates older serial presets to routing and amp defaults', () => {
  const legacy = {
    id: 'legacy', name: '旧音色', createdAt: 1, source: 'chords', output: 70,
    chain: [{ specId: 'blue-drive', settings: { level: 60, tone: 50, gain: 40 }, bypassed: false }],
  };
  const [migrated] = parseUserPresets(JSON.stringify([legacy]));
  assert.equal(migrated.routing.mode, 'serial');
  assert.equal(migrated.chain[0].lane, 'A');
  assert.equal(migrated.amp.ampId, 'brit-20');
  assert.equal(migrated.amp.cabId, 'closed-4x12');
  assert.deepEqual(migrated.source, { ...DEFAULT_SOURCE_CONFIG, performance: 'chords' });
});
