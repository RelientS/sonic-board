import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BoardHistory } from '../board-history.ts';

test('undo and redo walk the recorded states', () => {
  const history = new BoardHistory<number>();
  history.record(1, 0);
  history.record(2, 1_000);
  assert.equal(history.undo(3), 2);
  assert.equal(history.undo(2), 1);
  assert.equal(history.undo(1), null);
  assert.equal(history.redo(1), 2);
  assert.equal(history.redo(2), 3);
  assert.equal(history.canRedo, false);
});

test('a burst of edits (a knob drag) is one undo step', () => {
  const history = new BoardHistory<number>(100, 600);
  for (let i = 0; i < 20; i += 1) history.record(50 + i, i * 16);
  assert.equal(history.undo(70), 50);
  assert.equal(history.canUndo, false);
});

test('a new edit clears redo and the stack is bounded', () => {
  const history = new BoardHistory<number>(3, 0);
  [1, 2, 3, 4].forEach((value, i) => history.record(value, i * 10));
  assert.equal(history.undo(5), 4);
  history.record(4, 100);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(9), 4);
  assert.equal(history.undo(4), 3);
  assert.equal(history.undo(3), 2);
  assert.equal(history.undo(2), null);
});

test('the board wires undo to edits, shortcuts and toolbar buttons', () => {
  const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
  assert.match(page, /function markBoardChanged\(record = true\)/);
  assert.match(page, /history\.current\.record\(captureCurrentBoardUiState\(\)\)/);
  // Selecting, switching A/B, monitoring and restoring are not edits.
  for (const name of ['selectPedal', 'selectSnapshot', 'setMonitorMode', 'restoreBoardUiState']) {
    const body = page.slice(page.indexOf('function ' + name + '('));
    assert.match(body.slice(0, body.indexOf('\n  }\n')), /markBoardChanged\(false\)/, name);
  }
  assert.match(page, /if \(key === 'z' && !event\.shiftKey\) undoBoard\(\);/);
  assert.match(page, /aria-label="撤销"/);
  assert.match(page, /aria-label="重做"/);
});
