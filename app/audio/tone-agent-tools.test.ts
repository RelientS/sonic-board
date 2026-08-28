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
  assert.ok(runtime.searchEffects('metal').some((item) => item.id === 'chainsaw-dist'));
  assert.ok(runtime.searchEffects('清音').some((item) => item.id === 'studio-comp'));
  const rat = runtime.searchEffects('RAT')[0];
  assert.equal(rat.fidelity?.runtime, 'pedalkernel');
  assert.equal(rat.fidelity?.verifiedScore, null);
});

test('tool runtime records validated reversible actions instead of mutating context', () => {
  const runtime = createToneAgentToolRuntime(context);
  assert.throws(() => runtime.updateEffect('fuzz-1', { tone: 49 }), /先调用 inspect_board/);
  runtime.inspectBoard();
  const result = runtime.updateEffect('fuzz-1', { tone: 49, sustain: 66 });

  assert.equal(result.ok, true);
  assert.deepEqual(runtime.actions, [{ type: 'update_effect', instanceId: 'fuzz-1', values: { tone: 49, sustain: 66 } }]);
  assert.equal(context.values['fuzz-1'].tone, 43);
  assert.equal(runtime.inspectEffect('fuzz-1')?.values.tone, 49);
  assert.throws(() => runtime.updateEffect('fuzz-1', { fake: 10 }), /未知旋钮/);
});

test('tool runtime allows observations before inspect_board but gates every mutator', () => {
  const runtime = createToneAgentToolRuntime(context);
  assert.ok(runtime.inspectEffect('fuzz-1'));
  assert.ok(runtime.searchEffects('phase').length > 0);
  assert.throws(() => runtime.record({ type: 'set_output', value: 58 }), /先调用 inspect_board/);

  runtime.inspectBoard();
  assert.doesNotThrow(() => runtime.record({ type: 'set_output', value: 58 }));
  assert.equal(runtime.inspectBoard().output, 58);
});

test('tool runtime projects add, update, and remove actions for later inspection', () => {
  const runtime = createToneAgentToolRuntime(context);
  runtime.inspectBoard();
  const added = runtime.record({
    type: 'add_effect',
    instanceId: 'agent-phase-1',
    specId: 'slow-phase',
    lane: 'B',
    position: 0,
    values: { rate: 9 },
  });
  assert.equal(added.instanceId, 'agent-phase-1');
  assert.equal(runtime.inspectBoard().chain[0].instanceId, 'agent-phase-1');
  assert.equal(runtime.inspectEffect('agent-phase-1')?.values.rate, 9);

  runtime.updateEffect('agent-phase-1', { mix: 31 });
  assert.equal(runtime.inspectEffect('agent-phase-1')?.values.mix, 31);
  runtime.record({ type: 'remove_effect', instanceId: 'agent-phase-1' });
  assert.equal(runtime.inspectEffect('agent-phase-1'), null);
  assert.equal(context.chain.length, 1);
});

test('tool runtime enforces the cumulative action cap including update_effect', () => {
  const runtime = createToneAgentToolRuntime(context);
  runtime.inspectBoard();
  for (let index = 0; index < 16; index += 1) runtime.updateEffect('fuzz-1', { tone: index });
  assert.equal(runtime.actions.length, 16);
  assert.throws(() => runtime.updateEffect('fuzz-1', { tone: 17 }), /最多执行 16 个/);
  assert.equal(runtime.inspectEffect('fuzz-1')?.values.tone, 15);
});

test('board inspection exposes amp bypass and amp helpers preserve it by default', () => {
  const bypassedContext = { ...context, amp: { ...context.amp, bypassed: true } };
  const runtime = createToneAgentToolRuntime(bypassedContext);
  const inspected = runtime.inspectBoard();
  assert.equal(inspected.amp.bypassed, true);
  assert.equal(inspected.cabinet.bypassed, true);

  const replacement = runtime.makeAmpCab('glass-120', 'open-2x12');
  assert.equal(replacement.bypassed, true);
  runtime.record({ type: 'set_amp_cab', amp: replacement });
  assert.equal(runtime.inspectBoard().amp.bypassed, true);
});
