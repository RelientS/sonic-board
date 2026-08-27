import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AMP_SPECS,
  CAB_SPECS,
  getAmpSpec,
  getCabSpec,
  makeDefaultAmpCabConfig,
  validateAmpCatalog,
} from '../amps/catalog.ts';

test('amp and cabinet catalog covers the core clean and driven archetypes', () => {
  assert.ok(AMP_SPECS.length >= 5);
  assert.ok(CAB_SPECS.length >= 5);
  assert.deepEqual(validateAmpCatalog(), []);
  assert.ok(AMP_SPECS.some((amp) => amp.id === 'glass-120'));
  assert.ok(AMP_SPECS.some((amp) => amp.id === 'brit-20'));
  assert.ok(CAB_SPECS.some((cab) => cab.id === 'direct'));
});

test('every amp exposes a practical full tone stack', () => {
  const required = ['input', 'gain', 'bass', 'mid', 'treble', 'presence', 'master'];
  AMP_SPECS.forEach((amp) => {
    assert.deepEqual(amp.controls.map((control) => control.id), required);
    assert.ok(amp.controls.every((control) => control.defaultValue >= 0 && control.defaultValue <= 100));
  });
});

test('default amp and cabinet config contains complete model values', () => {
  const config = makeDefaultAmpCabConfig();
  assert.deepEqual(Object.keys(config.ampValues), getAmpSpec(config.ampId).controls.map((control) => control.id));
  assert.deepEqual(Object.keys(config.cabValues), getCabSpec(config.cabId).controls.map((control) => control.id));
  assert.equal(config.bypassed, false);
});

test('amp and cabinet references use their classic names without claiming official captures', () => {
  assert.deepEqual(AMP_SPECS.map((amp) => amp.name), [
    'Roland JC-120 Jazz Chorus',
    "Fender '65 Twin Reverb",
    'Marshall DSL20HR',
    'VOX AC30 Top Boost',
    'MESA/Boogie Dual Rectifier',
  ]);
  assert.deepEqual(CAB_SPECS.map((cab) => cab.name), [
    "Fender '65 Deluxe Reverb 1×12 Jensen C12K",
    "Fender '65 Twin Reverb 2×12 Jensen C12K",
    'VOX AC30C2X 2×12 Celestion Alnico Blue',
    'Marshall 1960A 4×12 Celestion G12T-75',
    'Direct / Full Range',
  ]);
  AMP_SPECS.forEach((amp) => assert.match(amp.modeling, /算法近似·非官方/));
  CAB_SPECS.slice(0, -1).forEach((cab) => assert.match(cab.modeling, /合成箱体·非实测 IR/));
  assert.match(CAB_SPECS.at(-1)!.modeling, /无箱体建模/);
});
