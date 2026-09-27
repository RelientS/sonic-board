import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { EFFECT_SPECS, formatControlValue } from '../effects/catalog.ts';
import { getEffectFidelity } from '../effects/fidelity.ts';

const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');

test('knobs drag vertically with fine mode, reset on double-click and announce their value', () => {
  assert.match(page, /onPointerDown=\{onPointerDown\}/);
  assert.match(page, /setPointerCapture\(event\.pointerId\)/);
  assert.match(page, /const travel = \(state\.y - event\.clientY\) \+ \(event\.clientX - state\.x\)/);
  assert.match(page, /state\.fine \? KNOB_FINE_FACTOR : 1/);
  assert.match(page, /onDoubleClick=\{\(\) => \{ if \(!disabled\) onChange\(control\.defaultValue\); \}\}/);
  assert.match(page, /aria-valuetext=\{readout\}/);
  // Wheel only acts on a focused knob so scrolling past the board is safe.
  assert.match(page, /document\.activeElement !== element/);
  assert.match(page, /target\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.match(styles, /\.knob-hit \{ cursor: ns-resize; touch-action: none;/);
  assert.match(styles, /\.knob-hit input \{[^}]*pointer-events: none;/);
});

test('two-position controls render as switches with their silk-screen labels', () => {
  const switches = EFFECT_SPECS.flatMap((spec) => spec.controls.filter((control) => control.options).map((control) => ({ spec, control })));
  assert.deepEqual(switches.map(({ spec, control }) => spec.id + ':' + control.id).sort(), ['ocd-drive:hp', 'opamp-muff:tonebypass']);
  for (const { control } of switches) {
    assert.ok(control.defaultValue === 0 || control.defaultValue === 100);
    assert.equal(formatControlValue(control, 0), control.options![0]);
    assert.equal(formatControlValue(control, 100), control.options![1]);
  }
  assert.match(page, /role="switch"/);
  assert.match(page, /onClick=\{\(\) => onChange\(on \? 0 : 100\)\}/);
});

test('A/B snapshots start identical and can be copied across', () => {
  assert.match(page, /return \{ A: cloneValues\(board\.values\), B: cloneValues\(board\.values\) \};/);
  assert.match(page, /\[other\]: cloneValues\(current\[snapshot\]\)/);
});

test('library marks and filters circuit-level pedals', () => {
  assert.match(page, /isCircuitModelled\(spec\.id\) && <em className="circuit-badge"/);
  assert.match(page, /const engineMatches = !circuitOnly \|\| isCircuitModelled\(spec\.id\)/);
  const circuit = EFFECT_SPECS.filter((spec) => getEffectFidelity(spec.id)?.runtime === 'circuit');
  assert.equal(circuit.length, 10);
});

test('live instrument input replaces the DI loop and is released on stop', () => {
  const engine = readFileSync(new URL('./audio-engine.ts', import.meta.url), 'utf8');
  assert.match(engine, /echoCancellation: false, noiseSuppression: false, autoGainControl: false/);
  assert.match(engine, /if \(session\.liveInput\) session\.liveInput\.output\.connect\(input\);\n\s*else source\.connect\(input\);/);
  assert.match(engine, /input\.stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(page, /const liveInputActive = liveInputOn && playing;/);
  // iOS interruptions: the context is resumed when visible or on the next touch.
  assert.match(engine, /state === 'suspended' \|\| state === 'interrupted'/);
});
