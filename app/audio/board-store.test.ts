import assert from 'node:assert/strict';
import test from 'node:test';

import { getAmpSpec } from '../amps/catalog.ts';
import { BoardHistory } from '../board-history.ts';
import { FACTORY_PRESETS, instantiatePreset, makeDefaultValues } from '../effects/catalog.ts';
import { captureUserPreset, instantiateUserPreset, parseUserPresets } from '../effects/user-presets.ts';
import {
  boardFromPreset,
  boardReducer,
  captureLayout,
  patchBroken,
  spotForCableInsert,
  laneItems,
  MAX_PEDALS,
  MIXER_NODE,
  nodeOrder,
  RIG_NODE,
  undoKeyFor,
  type BoardAction,
  type BoardUiState,
} from '../studio/board-store.ts';
import { connect, deriveChain, disconnect, heal } from '../studio/patch-graph.ts';

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


test('every pedal gets a spot on the board and the preset chain gets tidy cables', () => {
  const state = serialBoard();
  for (const item of state.chain) assert.ok(state.patch.positions[item.instanceId], item.instanceId);
  assert.equal(state.parked.length, 0);
  assert.equal(patchBroken(state), false);
  assert.deepEqual(deriveChain(state.chain, state.patch.cables, 'serial').chain.map((item) => item.instanceId), ids(state));
});

test('re-cabling changes the chain; unplugged pedals are parked and leave the audio chain', () => {
  const state = serialBoard();
  const [first, second, third] = ids(state);
  // Pull the cable out of the second pedal's input: only the first stays on the path.
  const unplugged = boardReducer(state, { type: 'patch', cables: disconnect(state.patch.cables, { node: second, port: 'in' }) });
  assert.deepEqual(ids(unplugged), [first]);
  assert.ok(unplugged.parked.some((item) => item.instanceId === second));
  assert.equal(patchBroken(unplugged), true);
  // The third's input still holds the cable from the second: that jack is occupied.
  const allNodes = new Set([...ids(unplugged), ...unplugged.parked.map((item) => item.instanceId), 'input', 'output']);
  assert.deepEqual(connect(unplugged.patch.cables, { node: first, port: 'out' }, { node: third, port: 'in' }, { nodes: allNodes, mode: 'serial' }), { ok: false, reason: 'occupied' });
  // Pull that plug too, then cable the first straight into the third: the second is skipped.
  const connected = connect(disconnect(unplugged.patch.cables, { node: third, port: 'in' }), { node: first, port: 'out' }, { node: third, port: 'in' }, { nodes: new Set([...ids(unplugged), ...unplugged.parked.map((item) => item.instanceId), 'input', 'output']), mode: 'serial' });
  assert.ok(connected.ok);
  const skipped = boardReducer(unplugged, { type: 'patch', cables: connected.ok ? connected.cables : [] });
  assert.equal(ids(skipped)[1], third);
  assert.ok(!ids(skipped).includes(second));
  assert.equal(undoKeyFor({ type: 'patch', cables: [] }), 'discrete');
  // A parked pedal keeps its values and can be cabled back onto the end.
  assert.ok(skipped.snapshots.A[second]);
  const back = boardReducer(skipped, { type: 'connectParked', instanceId: second, lane: 'A' });
  assert.equal(ids(back).at(-1), second);
  assert.equal(back.parked.length, 0);
});

test('placing a pedal is one undo step per drag and keyboard nudges coalesce', () => {
  const state = serialBoard();
  const id = ids(state)[0];
  const start = state.patch.positions[id];
  const { state: moved, history } = runWithHistory(state, [
    { type: 'place', id, x: start.x, y: start.y + 5 },
    { type: 'place', id, x: start.x, y: start.y + 10 },
  ], (i) => i * 100);
  assert.deepEqual(moved.patch.positions[id], { x: start.x, y: start.y + 10 });
  const undone = history.undo(moved)!;
  assert.deepEqual(undone.patch.positions[id], start);
  assert.equal(history.canUndo, false);
});

test('inserting on a cable splices the pedal in at the given spot; removing heals the cable', () => {
  const state = serialBoard();
  const [first, second] = ids(state);
  const cable = state.patch.cables.find((entry) => entry.from.node === first && entry.to.node === second)!;
  const at = spotForCableInsert(state, cable, 'rodent-dist')!;
  const inserted = boardReducer(state, { type: 'insertOnCable', specId: 'rodent-dist', instanceId: 'rat-x', cable, at });
  assert.deepEqual(ids(inserted).slice(0, 3), [first, 'rat-x', second]);
  assert.deepEqual(inserted.patch.positions['rat-x'], at);
  assert.equal(inserted.selected, 'rat-x');
  const removed = boardReducer(inserted, { type: 'remove', instanceId: 'rat-x' });
  assert.deepEqual(ids(removed), ids(state));
  assert.equal(patchBroken(removed), false);
  assert.equal(removed.patch.positions['rat-x'], undefined);
});

test('parallel mode adds the splitter and mixer; tidy re-lays the board as one step', () => {
  const state = serialBoard();
  const parallel = boardReducer(state, { type: 'setRouting', routing: { mode: 'parallel' } });
  assert.ok(parallel.patch.positions.splitter && parallel.patch.positions.mixer);
  assert.equal(patchBroken(parallel), false);
  assert.deepEqual(ids(parallel), ids(state));
  const lane = boardReducer(parallel, { type: 'move', instanceId: ids(parallel)[0], lane: 'B', slot: 0 });
  assert.equal(laneItems(lane.chain, 'parallel', 'B').length, 1);
  const tidied = boardReducer(lane, { type: 'tidy' });
  assert.notEqual(tidied, lane);
  assert.equal(undoKeyFor({ type: 'tidy' }), 'discrete');
  const back = boardReducer(tidied, { type: 'setRouting', routing: { mode: 'serial' } });
  assert.equal(back.patch.positions.splitter, undefined);
  assert.equal(patchBroken(back), false);
});

test('agent results keep parked pedals and their values; new pedals are placed', () => {
  const state = serialBoard();
  const parkedId = ids(state).at(-1)!;
  const parked = boardReducer(state, { type: 'patch', cables: heal(state.patch.cables, parkedId) });
  assert.ok(parked.parked.some((item) => item.instanceId === parkedId));
  const agentChain = [...parked.chain.map((item) => ({ ...item, lane: item.lane ?? 'A' as const })), { instanceId: 'agent-new', specId: 'rodent-dist', lane: 'A' as const }];
  const values: Record<string, Record<string, number>> = { ...parked.snapshots.A, 'agent-new': makeDefaultValues('rodent-dist') };
  delete values[parkedId];
  const next = boardReducer(parked, {
    type: 'applyAgent',
    replaceSnapshots: false,
    board: { name: 'x', selectedInstanceId: '', chain: agentChain, values, bypassed: [], source: parked.source, routing: parked.routing, amp: parked.amp, output: parked.output, monitorMode: 'wet' },
  });
  assert.ok(next.parked.some((item) => item.instanceId === parkedId));
  assert.ok(next.snapshots.A[parkedId]);
  assert.ok(next.patch.positions['agent-new']);
  assert.equal(ids(next).at(-1), 'agent-new');
});

test('user presets keep the layout and parked pedals across save and load', () => {
  const state = serialBoard();
  const parkedId = ids(state)[1];
  const edited = boardReducer(state, { type: 'patch', cables: heal(state.patch.cables, parkedId) });
  const moved = boardReducer(edited, { type: 'place', id: ids(edited)[0], x: 300, y: 150 });
  const captured = captureUserPreset({ name: 't', chain: moved.chain, parked: moved.parked, layout: captureLayout(moved), values: moved.snapshots.A, bypassed: moved.bypassed, source: moved.source, output: moved.output, routing: moved.routing, amp: moved.amp });
  const [parsed] = parseUserPresets(JSON.stringify([captured]));
  const loaded = boardFromPreset(instantiateUserPreset(parsed), parsed.name);
  assert.equal(loaded.chain.length, moved.chain.length);
  assert.equal(loaded.parked.length, 1);
  assert.equal(loaded.parked[0].specId, moved.parked[0].specId);
  assert.deepEqual(loaded.patch.positions[loaded.chain[0].instanceId], { x: 300, y: 150 });
});
