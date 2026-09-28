import assert from 'node:assert/strict';
import test from 'node:test';

import { FACTORY_PRESETS, instantiatePreset } from '../effects/catalog.ts';
import { boardFromPreset, boardReducer } from '../studio/board-store.ts';
import { studioSource } from './studio-sources.ts';

const page = studioSource;

function startBoard() {
  const preset = FACTORY_PRESETS.find((entry) => entry.chain.length >= 3) ?? FACTORY_PRESETS[0];
  return boardFromPreset(instantiatePreset(preset), preset.name);
}

test('removing a pedal cleans every board state store', () => {
  let state = startBoard();
  const [first, second] = state.chain;
  state = boardReducer(state, { type: 'bypass', instanceId: second.instanceId });
  state = boardReducer(state, { type: 'focus', id: second.instanceId });
  const next = boardReducer(state, { type: 'remove', instanceId: second.instanceId });
  assert.ok(!next.chain.some((item) => item.instanceId === second.instanceId));
  assert.equal(next.snapshots.A[second.instanceId], undefined);
  assert.equal(next.snapshots.B[second.instanceId], undefined);
  assert.equal(next.bypassed.has(second.instanceId), false);
  // Focus moves to the neighbour rather than disappearing.
  assert.equal(next.selected, first.instanceId);
});

test('Agent local updates retain the inactive A/B snapshot while replacements reset both', () => {
  let state = startBoard();
  const target = state.chain[0].instanceId;
  state = boardReducer(state, { type: 'selectSnapshot', snapshot: 'B' });
  state = boardReducer(state, { type: 'setValue', instanceId: target, controlId: 'probe', value: 11 });
  state = boardReducer(state, { type: 'selectSnapshot', snapshot: 'A' });
  const agentBoard = {
    name: 'Agent',
    selectedInstanceId: target,
    chain: state.chain.map((item) => ({ ...item, lane: item.lane ?? 'A' as const })),
    values: { ...state.snapshots.A, [target]: { ...state.snapshots.A[target], probe: 99 } },
    bypassed: [],
    source: state.source,
    routing: state.routing,
    amp: state.amp,
    output: state.output,
    monitorMode: 'wet' as const,
  };
  const local = boardReducer(state, { type: 'applyAgent', board: agentBoard, replaceSnapshots: false });
  assert.equal(local.snapshots.A[target].probe, 99);
  assert.equal(local.snapshots.B[target].probe, 11);
  const replaced = boardReducer(state, { type: 'applyAgent', board: agentBoard, replaceSnapshots: true });
  assert.equal(replaced.snapshots.B[target].probe, 99);
  assert.equal(replaced.snapshot, 'A');
  assert.match(page, /function applyToneAgentBoard\(nextBoard: ToneAgentBoardState, replaceSnapshots = false\)/);
  assert.match(page, /const replaceSnapshots = plan\.actions\.some\(\(action\) => action\.type === 'replace_board'\);/);
});

test('Agent requests capture a baseline and reject responses from a changed board', () => {
  assert.match(page, /const requestRevision = boardRevision\.current;[\s\S]*?const undoBaseline = captureCurrentBoardUiState\(\);[\s\S]*?const context = captureToneAgentBoard\(toneAgentBoard\);[\s\S]*?requestToneAgentStream/);
  assert.match(page, /if \(boardRevision\.current !== requestRevision\)/);
  assert.match(page, /已忽略这次过期结果/);
  assert.match(page, /status: 'failed'/);
  // Focus changes do not count as edits for the agent's revision check.
  assert.match(page, /commit\(next, action\.type === 'focus'\)/);
});

test('Agent undo entries are revision guarded and restore the complete baseline', () => {
  assert.match(page, /type AgentUndoEntry = \{[\s\S]*?baseline: BoardUiState;[\s\S]*?appliedRevision: number;/);
  assert.match(page, /agentUndo\.current\.set\(turnId, \{ baseline: undoBaseline, appliedRevision: boardRevision\.current \}\)/);
  assert.match(page, /if \(boardRevision\.current !== entry\.appliedRevision\)/);
  assert.match(page, /当前音色已发生新的调整，无法撤销这次 Agent 操作/);
  assert.match(page, /restoreBoardUiState\(entry\.baseline\)/);
  assert.match(page, /snapshots: \{ A: cloneValues\(state\.snapshots\.A\), B: cloneValues\(state\.snapshots\.B\) \}/);
  assert.match(page, /snapshot: state\.snapshot/);
});

test('Agent turn IDs are deterministic within the mounted workbench', () => {
  assert.match(page, /const agentTurnSerial = useRef\(0\);/);
  assert.match(page, /agentTurnSerial\.current \+= 1;/);
  assert.match(page, /const turnId = `tone-agent-\$\{agentTurnSerial\.current\}`;/);
});
