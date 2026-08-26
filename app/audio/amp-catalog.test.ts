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
