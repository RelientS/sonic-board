import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardHistory } from '../board-history.ts';
import { studioSource } from './studio-sources.ts';

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

test('edits of the same control coalesce; different gestures stay separate steps', () => {
  const history = new BoardHistory<number>(100, 600);
  history.record(1, 0, 'value:a:gain');
  history.record(2, 10, 'value:a:gain');
  history.record(3, 20, 'value:a:tone');
  assert.equal(history.undo(4), 3);
  assert.equal(history.undo(3), 1);
  assert.equal(history.canUndo, false);
});

test('the board records undo in one place and exposes it in the top bar and keyboard', () => {
  const page = studioSource;
  assert.match(page, /const key = undoKeyFor\(action\);/);
  assert.match(page, /history\.current\.record\(previous, performance\.now\(\), key === 'discrete'/);
  assert.match(page, /case 'undo': board\.undo\(\); break;/);
  assert.match(page, /aria-label="撤销"/);
  assert.match(page, /aria-label="重做"/);
});
