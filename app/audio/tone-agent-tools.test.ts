import assert from 'node:assert/strict';
import test from 'node:test';

import { createToneAgentToolRuntime, type ToneAgentBoardState } from '../agent/tone-agent-runtime.ts';
import { makeAmpCabConfig } from '../amps/catalog.ts';

const context: ToneAgentBoardState = {
  name: '厚墙',
  selectedInstanceId: 'fuzz-1',
  chain: [{ instanceId: 'fuzz-1', specId: 'wall-fuzz', lane: 'A' }],
  values: { 'fuzz-1': { volume: 58, tone: 43, sustain: 78 } },
  bypassed: [],
  source: { guitar: 'humbucker', performance: 'wall-strum', progression: 'minor-drift' },
  routing: { mode: 'serial', blend: 50, spread: 0 },
  amp: makeAmpCabConfig('brit-20', 'closed-4x12'),
  output: 61,
  monitorMode: 'wet',
};

test('tool runtime reads the actual board and returns catalog-grounded teaching data', () => {
  const runtime = createToneAgentToolRuntime(context);
  const board = runtime.inspectBoard();
  const effect = runtime.inspectEffect('fuzz-1');
  const search = runtime.searchEffects('相位 flow', 'Mod');

  assert.match(board.summary, /1 块效果器/);
  assert.equal(board.selectedInstanceId, 'fuzz-1');
  assert.match(board.chain[0].name, /Big Muff/);
  assert.equal(effect?.values.sustain, 78);
  assert.equal(effect?.fidelity?.runtime, 'pedalkernel');
  assert.equal(effect?.fidelity?.status, 'candidate');
  assert.ok(effect?.controls.some((control) => control.id === 'sustain' && control.help.length > 20));
  assert.ok(search.some((item) => item.id === 'slow-phase'));
  const rat = runtime.searchEffects('RAT')[0];
  assert.equal(rat.fidelity?.runtime, 'pedalkernel');
  assert.equal(rat.fidelity?.verifiedScore, null);
});

test('tool runtime records validated reversible actions instead of mutating context', () => {
  const runtime = createToneAgentToolRuntime(context);
  const result = runtime.updateEffect('fuzz-1', { tone: 49, sustain: 66 });

  assert.equal(result.ok, true);
  assert.deepEqual(runtime.actions, [{ type: 'update_effect', instanceId: 'fuzz-1', values: { tone: 49, sustain: 66 } }]);
  assert.equal(context.values['fuzz-1'].tone, 43);
  assert.throws(() => runtime.updateEffect('fuzz-1', { fake: 10 }), /未知旋钮/);
});
