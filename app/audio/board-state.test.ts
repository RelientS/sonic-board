import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

test('removing a selected pedal cleans every board state store', () => {
  assert.match(page, /function removeSelected\(\)[\s\S]*?if \(selectedIndex < 0\) return;/);
  assert.match(page, /setSnapshots\(\(current\) => \(\{[\s\S]*?A: removeInstanceValues\(current\.A, removedInstanceId\),[\s\S]*?B: removeInstanceValues\(current\.B, removedInstanceId\)/);
  assert.match(page, /setBypassed\(\(current\) => \{[\s\S]*?next\.delete\(removedInstanceId\)/);
});

test('Agent local updates retain the inactive A/B snapshot while replacements reset both', () => {
  assert.match(page, /function applyToneAgentBoard\(board: ToneAgentBoardState, replaceSnapshots = false\)/);
  assert.match(page, /if \(replaceSnapshots\) return \{ A: nextValues, B: cloneValues\(nextValues\) \};/);
  assert.match(page, /const inactiveSnapshot = snapshot === 'A' \? 'B' : 'A';/);
  assert.match(page, /return snapshot === 'A'[\s\S]*?\{ A: nextValues, B: preservedInactive \}[\s\S]*?: \{ A: preservedInactive, B: nextValues \};/);
  assert.match(page, /const replaceSnapshots = plan\.actions\.some\(\(action\) => action\.type === 'replace_board'\);/);
});

test('Agent requests capture a baseline and reject responses from a changed board', () => {
  assert.match(page, /const requestRevision = boardRevision\.current;[\s\S]*?const undoBaseline = captureCurrentBoardUiState\(\);[\s\S]*?const context = captureToneAgentBoard\(toneAgentBoard\);[\s\S]*?requestToneAgentStream/);
  assert.match(page, /if \(boardRevision\.current !== requestRevision\)/);
  assert.match(page, /已忽略这次过期结果/);
  assert.match(page, /status: 'failed'/);
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
