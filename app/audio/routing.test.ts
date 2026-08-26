import assert from 'node:assert/strict';
import test from 'node:test';

import type { AudioChainItem } from './audio-core.ts';
import { computeLaneMix, partitionChain } from './routing.ts';

const chain: AudioChainItem[] = [
  { instanceId: 'phase-a', specId: 'slow-phase', lane: 'A' },
  { instanceId: 'reverse-b', specId: 'reverse-space', lane: 'B' },
  { instanceId: 'fuzz-a', specId: 'wall-fuzz', lane: 'A' },
  { instanceId: 'legacy', specId: 'graphic-eq' },
];

test('serial routing preserves the complete pedal order', () => {
  const routes = partitionChain(chain, 'serial');
  assert.deepEqual(routes.serial.map((item) => item.instanceId), ['phase-a', 'reverse-b', 'fuzz-a', 'legacy']);
  assert.deepEqual(routes.A, []);
  assert.deepEqual(routes.B, []);
});

test('parallel routing keeps order within each lane and migrates legacy pedals to A', () => {
  const routes = partitionChain(chain, 'parallel');
  assert.deepEqual(routes.serial, []);
  assert.deepEqual(routes.A.map((item) => item.instanceId), ['phase-a', 'fuzz-a', 'legacy']);
  assert.deepEqual(routes.B.map((item) => item.instanceId), ['reverse-b']);
});

test('lane mix uses constant-power blending and symmetrical stereo spread', () => {
  assert.deepEqual(computeLaneMix(0, 100), { A: { gain: 1, pan: -1 }, B: { gain: 0, pan: 1 } });
  assert.deepEqual(computeLaneMix(100, 100), { A: { gain: 0, pan: -1 }, B: { gain: 1, pan: 1 } });

  const centered = computeLaneMix(50, 0);
  assert.equal(centered.A.pan, 0);
  assert.equal(centered.B.pan, 0);
  assert.ok(Math.abs(centered.A.gain - Math.SQRT1_2) < 0.0001);
  assert.ok(Math.abs(centered.B.gain - Math.SQRT1_2) < 0.0001);
});
