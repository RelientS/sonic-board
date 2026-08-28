import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyToneAgentActions,
  createToneAgentToolRuntime,
  validateToneAgentBoardState,
  type ToneAgentBoardState,
  type ToneAgentAction,
} from '../agent/tone-agent-runtime.ts';
import { makeAmpCabConfig } from '../amps/catalog.ts';

function board(): ToneAgentBoardState {
  return {
    name: '当前音色',
    chain: [
      { instanceId: 'phase-1', specId: 'slow-phase', lane: 'A' },
      { instanceId: 'fuzz-1', specId: 'wall-fuzz', lane: 'A' },
    ],
    values: {
      'phase-1': { rate: 18, depth: 38, res: 18, mix: 44 },
      'fuzz-1': { volume: 58, tone: 43, sustain: 67 },
    },
    bypassed: [],
    source: { guitar: 'single-neck', performance: 'chords', progression: 'dream-open' },
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('brit-20', 'closed-4x12'),
    output: 63,
    monitorMode: 'wet',
  };
}

test('agent actions make bounded parameter changes against the current board', () => {
  const actions: ToneAgentAction[] = [
    { type: 'update_effect', instanceId: 'phase-1', values: { rate: 9, mix: 31 } },
    { type: 'set_output', value: 58 },
    { type: 'set_source', source: { guitar: 'humbucker', performance: 'wall-strum', progression: 'minor-drift' } },
  ];

  const result = applyToneAgentActions(board(), actions);

  assert.equal(result.errors.length, 0);
  assert.equal(result.changed, 3);
  assert.deepEqual(result.board.values['phase-1'], { rate: 9, depth: 38, res: 18, mix: 31 });
  assert.equal(result.board.output, 58);
  assert.equal(result.board.source.performance, 'wall-strum');
  assert.equal(result.board.name, 'Agent 已调整');
});

test('agent actions can add, move, bypass, route, and remove pedals without corrupting values', () => {
  const actions: ToneAgentAction[] = [
    { type: 'add_effect', instanceId: 'eq-agent-1', specId: 'graphic-eq', lane: 'B', position: 1, values: { '800': 62, level: 55 } },
    { type: 'move_effect', instanceId: 'fuzz-1', position: 0, lane: 'B' },
    { type: 'set_bypass', instanceId: 'phase-1', bypassed: true },
    { type: 'set_routing', routing: { mode: 'parallel', blend: 54, spread: 82 } },
    { type: 'remove_effect', instanceId: 'phase-1' },
  ];

  const result = applyToneAgentActions(board(), actions);

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.board.chain.map((item) => [item.instanceId, item.lane]), [
    ['fuzz-1', 'B'],
    ['eq-agent-1', 'B'],
  ]);
  assert.equal(result.board.values['eq-agent-1']['800'], 62);
  assert.equal(result.board.values['eq-agent-1'].level, 55);
  assert.equal(result.board.values['phase-1'], undefined);
  assert.deepEqual(result.board.bypassed, []);
  assert.equal(result.board.routing.mode, 'parallel');
});

test('agent actions reject unknown pedals, controls, and out-of-range values', () => {
  const result = applyToneAgentActions(board(), [
    { type: 'update_effect', instanceId: 'phase-1', values: { imaginary: 10 } },
    { type: 'update_effect', instanceId: 'missing', values: { mix: 20 } },
    { type: 'set_output', value: 140 },
  ] as ToneAgentAction[]);

  assert.equal(result.changed, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /未知旋钮/);
  assert.deepEqual(result.board, board());
});

test('agent can replace the whole board with a validated catalog recipe', () => {
  const result = applyToneAgentActions(board(), [{
    type: 'replace_board',
    name: '反向教学墙',
    preset: {
      id: 'agent-recipe',
      name: '反向教学墙',
      description: '反向空间进入法兹，再补中频。',
      source: { guitar: 'humbucker', performance: 'wall-strum', progression: 'minor-drift' },
      output: 60,
      routing: { mode: 'serial', blend: 50, spread: 0 },
      amp: makeAmpCabConfig('brit-20', 'closed-4x12', { gain: 28, mid: 64 }),
      chain: [
        { specId: 'reverse-space', settings: { mix: 48, decay: 56 } },
        { specId: 'wall-fuzz', settings: { sustain: 74, tone: 48 } },
        { specId: 'graphic-eq', settings: { '800': 61, '1600': 60 } },
      ],
    },
  }]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.changed, 1);
  assert.equal(result.board.name, '反向教学墙');
  assert.deepEqual(result.board.chain.map((item) => item.specId), ['reverse-space', 'wall-fuzz', 'graphic-eq']);
  assert.equal(result.board.values[result.board.chain[1].instanceId].tone, 48);
});

test('action application rejects a seventeenth action explicitly without partial changes', () => {
  const original = board();
  const actions: ToneAgentAction[] = Array.from({ length: 17 }, (_, index) => ({
    type: 'update_effect',
    instanceId: 'phase-1',
    values: { rate: index },
  }));
  const result = applyToneAgentActions(original, actions);

  assert.equal(result.changed, 0);
  assert.match(result.errors[0], /最多执行 16 个/);
  assert.deepEqual(result.board, original);
});

test('action batches apply atomically when a later action is invalid', () => {
  const original = board();
  const result = applyToneAgentActions(original, [
    { type: 'set_output', value: 58 },
    { type: 'set_monitor', mode: 'invalid' as 'wet' },
  ]);

  assert.equal(result.changed, 0);
  assert.match(result.errors[0], /监听模式/);
  assert.deepEqual(result.board, original);
});

test('board validation rejects malformed monitor, amp bypass, and incomplete controls', () => {
  const valid = board();
  assert.deepEqual(validateToneAgentBoardState(valid), []);
  assert.match(validateToneAgentBoardState({ ...valid, monitorMode: 'invalid' })[0], /监听模式/);
  assert.match(validateToneAgentBoardState({ ...valid, amp: { ...valid.amp, bypassed: 'yes' } })[0], /箱头或箱体状态/);
  assert.match(validateToneAgentBoardState({ ...valid, values: { ...valid.values, 'phase-1': { rate: 18 } } })[0], /参数不完整/);
  assert.throws(() => createToneAgentToolRuntime({ ...valid, monitorMode: 'invalid' } as unknown as ToneAgentBoardState), /监听模式/);
});

test('amp replacement preserves bypass unless the action changes it explicitly', () => {
  const original = board();
  original.amp.bypassed = true;
  const replacement = makeAmpCabConfig('glass-120', 'open-2x12');
  const ampWithoutBypass = {
    ampId: replacement.ampId,
    cabId: replacement.cabId,
    ampValues: replacement.ampValues,
    cabValues: replacement.cabValues,
  };
  const preserved = applyToneAgentActions(original, [{ type: 'set_amp_cab', amp: ampWithoutBypass } as ToneAgentAction]);

  assert.equal(preserved.errors.length, 0);
  assert.equal(preserved.board.amp.bypassed, true);
  replacement.bypassed = false;
  const changed = applyToneAgentActions(original, [{ type: 'set_amp_cab', amp: replacement }]);
  assert.equal(changed.errors.length, 0);
  assert.equal(changed.board.amp.bypassed, false);
  assert.equal(original.amp.bypassed, true);
});
