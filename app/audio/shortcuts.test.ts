import assert from 'node:assert/strict';
import test from 'node:test';

import { shortcutFor, type KeyContext, type KeyInput } from '../studio/shortcuts.ts';

const key = (value: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...extra });
const board: KeyContext = { target: 'other', modalOpen: false };

test('the studio keyboard map', () => {
  assert.deepEqual(shortcutFor(key(' '), board), { type: 'play' });
  assert.deepEqual(shortcutFor(key('b'), board), { type: 'bypass' });
  assert.deepEqual(shortcutFor(key('ArrowLeft'), board), { type: 'focusPrev' });
  assert.deepEqual(shortcutFor(key('ArrowRight'), board), { type: 'focusNext' });
  assert.deepEqual(shortcutFor(key('ArrowLeft', { altKey: true }), board), { type: 'movePrev' });
  assert.deepEqual(shortcutFor(key('ArrowRight', { altKey: true }), board), { type: 'moveNext' });
  assert.deepEqual(shortcutFor(key('3'), board), { type: 'focusIndex', index: 2 });
  assert.deepEqual(shortcutFor(key('k', { metaKey: true }), board), { type: 'picker' });
  assert.deepEqual(shortcutFor(key('k', { ctrlKey: true }), board), { type: 'picker' });
  assert.deepEqual(shortcutFor(key('Delete'), board), { type: 'remove' });
  assert.deepEqual(shortcutFor(key('Backspace'), board), { type: 'remove' });
  assert.deepEqual(shortcutFor(key('Escape'), board), { type: 'close' });
  assert.deepEqual(shortcutFor(key('z', { ctrlKey: true }), board), { type: 'undo' });
  assert.deepEqual(shortcutFor(key('Z', { ctrlKey: true, shiftKey: true }), board), { type: 'redo' });
  assert.deepEqual(shortcutFor(key('y', { metaKey: true }), board), { type: 'redo' });
  assert.deepEqual(shortcutFor(key('d'), board), { type: 'dryHold' });
  assert.deepEqual(shortcutFor(key('?', { shiftKey: true }), board), { type: 'help' });
});

test('auto-repeat does not re-trigger play or the dry hold', () => {
  assert.equal(shortcutFor(key(' ', { repeat: true }), board), null);
  assert.equal(shortcutFor(key('d', { repeat: true }), board), null);
});

test('typing, knobs and modals keep their own keys', () => {
  const typing: KeyContext = { target: 'text', modalOpen: false };
  for (const input of [key(' '), key('b'), key('Backspace'), key('3'), key('k', { metaKey: true })]) assert.equal(shortcutFor(input, typing), null);
  const knob: KeyContext = { target: 'range', modalOpen: false };
  assert.equal(shortcutFor(key('ArrowLeft'), knob), null, 'arrows adjust the knob');
  assert.equal(shortcutFor(key('Delete'), knob), null);
  assert.deepEqual(shortcutFor(key(' '), knob), { type: 'play' });
  assert.deepEqual(shortcutFor(key('z', { metaKey: true }), knob), { type: 'undo' });
  assert.equal(shortcutFor(key('ArrowRight'), { target: 'other', modalOpen: true }), null);
});
