import assert from 'node:assert/strict';
import test from 'node:test';

import { getAmpSpec } from '../amps/catalog.ts';
import { BoardHistory } from '../board-history.ts';
import { FACTORY_PRESETS, instantiatePreset } from '../effects/catalog.ts';
import {
  boardFromPreset,
  boardReducer,
  laneItems,
  MAX_PEDALS,
  MIXER_NODE,
  nodeOrder,
  RIG_NODE,
  undoKeyFor,
  type BoardAction,
  type BoardUiState,
} from '../studio/board-store.ts';
import { layoutParallel, layoutSerial, NODE } from '../studio/board-layout.ts';

function serialBoard() {
  const preset = FACTORY_PRESETS.find((entry) => entry.routing.mode === 'serial' && entry.chain.length >= 3) ?? FACTORY_PRESETS[0];
  return boardFromPreset(instantiatePreset(preset), preset.name);
}

const ids = (state: BoardUiState) => state.chain.map((item) => item.instanceId);

/** Mirrors useBoard: edits record an undo step, keyed so drags coalesce. */
function runWithHistory(start: BoardUiState, actions: BoardAction[], at = (i: number) => i * 1_000) {
  const history = new BoardHistory<BoardUiState>();
  let state = start;
  let serial = 0;
  actions.forEach((action, i) => {
    const next = boardReducer(state, action);
    if (next === state) return;
    const key = undoKeyFor(action);
    if (key) history.record(state, at(i), key === 'discrete' ? `d${++serial}` : key);
    state = next;
  });
  return { state, history };
}

test('add inserts at the requested slot and focuses the new pedal', () => {
  const start = serialBoard();
  const next = boardReducer(start, { type: 'add', specId: start.chain[0].specId, instanceId: 'new-1', lane: 'A', index: 1 });
  assert.equal(ids(next)[1], 'new-1');
  assert.equal(next.chain.length, start.chain.length + 1);
  assert.equal(next.selected, 'new-1');
  assert.ok(next.snapshots.A['new-1'] && next.snapshots.B['new-1']);
  assert.equal(next.activePresetName, '已修改');
  const atEnd = boardReducer(start, { type: 'add', specId: start.chain[0].specId, instanceId: 'new-2', lane: 'A', index: 99 });
  assert.equal(ids(atEnd).at(-1), 'new-2');
});

test('add respects the pedal limit', () => {
  let state = serialBoard();
  for (let i = 0; state.chain.length < MAX_PEDALS; i += 1) {
    state = boardReducer(state, { type: 'add', specId: state.chain[0].specId, instanceId: `fill-${i}`, lane: 'A', index: 0 });
  }
  assert.equal(boardReducer(state, { type: 'add', specId: state.chain[0].specId, instanceId: 'over', lane: 'A', index: 0 }), state);
});

test('parallel inserts land in the requested lane at the requested position', () => {
  let state = serialBoard();
  state = boardReducer(state, { type: 'setRouting', routing: { mode: 'parallel' } });
  const laneBBefore = laneItems(state.chain, 'parallel', 'B').length;
  state = boardReducer(state, { type: 'add', specId: state.chain[0].specId, instanceId: 'b-0', lane: 'B', index: 0 });
  const laneB = laneItems(state.chain, 'parallel', 'B');
  assert.equal(laneB.length, laneBBefore + 1);
  assert.equal(laneB[0].instanceId, 'b-0');
});

test('move uses displayed slots and ignores drops next to the pedal itself', () => {
  const start = serialBoard();
  const [a, b, c] = ids(start);
  // Slots around the pedal itself change nothing.
  assert.equal(boardReducer(start, { type: 'move', instanceId: a, lane: 'A', slot: 0 }), start);
  assert.equal(boardReducer(start, { type: 'move', instanceId: a, lane: 'A', slot: 1 }), start);
  // Slot 3 is after the third pedal: the first pedal lands behind it.
  const moved = boardReducer(start, { type: 'move', instanceId: a, lane: 'A', slot: 3 });
  assert.deepEqual(ids(moved).slice(0, 3), [b, c, a]);
  const back = boardReducer(moved, { type: 'move', instanceId: a, lane: 'A', slot: 0 });
  assert.deepEqual(ids(back).slice(0, 3), [a, b, c]);
});

test('nudge moves a pedal one place within its lane and stops at the ends', () => {
  const start = serialBoard();
  const [a, b] = ids(start);
  const later = boardReducer(start, { type: 'nudge', instanceId: a, direction: 1 });
  assert.deepEqual(ids(later).slice(0, 2), [b, a]);
  assert.equal(boardReducer(start, { type: 'nudge', instanceId: a, direction: -1 }), start);
});

test('moving across lanes reassigns the lane', () => {
  let state = boardReducer(serialBoard(), { type: 'setRouting', routing: { mode: 'parallel' } });
  const pedal = laneItems(state.chain, 'parallel', 'A')[0];
  state = boardReducer(state, { type: 'move', instanceId: pedal.instanceId, lane: 'B', slot: 0 });
  assert.equal(laneItems(state.chain, 'parallel', 'B')[0].instanceId, pedal.instanceId);
});

test('a combo brings its speaker in one step; heads keep the cab', () => {
  const start = serialBoard();
  const twin = getAmpSpec('american-twin');
  const combo = boardReducer(start, { type: 'selectCombo', ampId: twin.id });
  assert.equal(combo.amp.ampId, twin.id);
  assert.equal(combo.amp.cabId, twin.speakerCab);
  const head = boardReducer(combo, { type: 'selectHead', ampId: 'dark-stack' });
  assert.equal(head.amp.cabId, twin.speakerCab);
  const { history, state } = runWithHistory(start, [{ type: 'selectCombo', ampId: twin.id }]);
  assert.equal(state.amp.ampId, twin.id);
  const undone = history.undo(state)!;
  assert.equal(undone.amp.ampId, start.amp.ampId);
  assert.equal(undone.amp.cabId, start.amp.cabId);
});

test('each edit is one undo step; a knob drag is one step; focus and monitoring are not steps', () => {
  const start = serialBoard();
  const target = start.chain[0].instanceId;
  const drag: BoardAction[] = Array.from({ length: 12 }, (_, i) => ({ type: 'setValue', instanceId: target, controlId: 'gain', value: 10 + i }));
  const { state, history } = runWithHistory(start, [
    ...drag,
    { type: 'bypass', instanceId: target },
    { type: 'focus', id: RIG_NODE },
    { type: 'setMode', mode: 'dry' },
    { type: 'selectSnapshot', snapshot: 'B' },
  ], (i) => i * 16);
  assert.equal(state.snapshots.A[target].gain, 21);
  assert.equal(state.bypassed.has(target), true);
  const afterBypassUndo = history.undo(state)!;
  assert.equal(afterBypassUndo.bypassed.has(target), start.bypassed.has(target));
  const afterDragUndo = history.undo(afterBypassUndo)!;
  assert.equal(afterDragUndo.snapshots.A[target].gain, start.snapshots.A[target].gain);
  assert.equal(history.canUndo, false);
  assert.equal(undoKeyFor({ type: 'focus', id: MIXER_NODE }), null);
  assert.equal(undoKeyFor({ type: 'setMode', mode: 'dry' }), null);
  assert.equal(undoKeyFor({ type: 'setOutput', output: 40 }), null);
});

test('node order walks pedals in signal order, then the mixer and the rig', () => {
  let state = serialBoard();
  assert.deepEqual(nodeOrder(state), [...ids(state), MIXER_NODE, RIG_NODE]);
  state = boardReducer(state, { type: 'setRouting', routing: { mode: 'parallel' } });
  const order = nodeOrder(state);
  const laneA = laneItems(state.chain, 'parallel', 'A').map((item) => item.instanceId);
  assert.deepEqual(order.slice(0, laneA.length), laneA);
  assert.deepEqual(order.slice(-2), [MIXER_NODE, RIG_NODE]);
});

test('the board fits the stage: long chains snake onto more tiers instead of scrolling', () => {
  const short = layoutSerial([NODE.pedal, NODE.pedal, NODE.pedal], 1400, 600);
  assert.equal(short.mode === 'serial' && short.rows.length, 1);
  assert.ok(short.scale * short.width <= 1400 + 0.5);
  const long = layoutSerial(Array.from({ length: 12 }, () => NODE.pedal), 1200, 700);
  assert.ok(long.mode === 'serial' && long.rows.length > 1, 'twelve pedals need a second tier');
  assert.ok(long.scale * long.width <= 1200 + 0.5 && long.scale * long.height <= 700 + 0.5);
  if (long.mode === 'serial') assert.deepEqual(long.rows.flat(), Array.from({ length: 12 }, (_, i) => i));
  const parallel = layoutParallel([NODE.pedal, NODE.pedal], [NODE.pedal], 1200, 700);
  assert.ok(parallel.scale * parallel.width <= 1200 + 0.5);
});
