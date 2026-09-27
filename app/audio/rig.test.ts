import assert from 'node:assert/strict';
import test from 'node:test';

import { AMP_SPECS, CAB_SPECS, getAmpSpec, getCabSpec, makeAmpCabConfig, registerNamAmps } from '../amps/catalog.ts';
import { combosIn, headsIn, rigModeOf, speakerCount, withCab, withCombo, withHead } from '../studio/rig-model.ts';

test('built-in amps split into combos with a speaker and free-pairing heads', () => {
  const combos = combosIn(AMP_SPECS);
  const heads = headsIn(AMP_SPECS);
  assert.equal(combos.length + heads.length, AMP_SPECS.length);
  assert.ok(combos.length > 0 && heads.length > 0);
  combos.forEach((amp) => assert.ok(amp.speakerCab && CAB_SPECS.some((cab) => cab.id === amp.speakerCab), amp.id));
  assert.equal(rigModeOf(getAmpSpec('american-twin')), 'combo');
  assert.equal(rigModeOf(getAmpSpec('brit-20')), 'head');
});

test('picking a combo sets the amp and its built-in speaker in one config', () => {
  const start = makeAmpCabConfig('brit-20', 'marshall-4x12-greenback', {}, { position: 80 });
  const twin = getAmpSpec('american-twin');
  const next = withCombo(start, twin);
  assert.equal(next.ampId, 'american-twin');
  assert.equal(next.cabId, twin.speakerCab);
  assert.deepEqual(Object.keys(next.cabValues), getCabSpec(twin.speakerCab!).controls.map((control) => control.id));
  // Same speaker: the mic placement survives.
  const moved = { ...next, cabValues: { ...next.cabValues, position: 12 } };
  assert.equal(withCombo(moved, twin).cabValues.position, 12);
});

test('picking a head keeps whatever cab is connected; cabs pair freely', () => {
  const start = makeAmpCabConfig('american-twin', 'open-2x12');
  const head = withHead(start, getAmpSpec('dark-stack'));
  assert.equal(head.ampId, 'dark-stack');
  assert.equal(head.cabId, 'open-2x12');
  const cab = withCab(head, 'mesa-2x12-v30');
  assert.equal(cab.ampId, 'dark-stack');
  assert.equal(cab.cabId, 'mesa-2x12-v30');
});

test('private NAM captures follow their manifest format', () => {
  registerNamAmps([
    { id: 'rig-test-combo', amp: 'Test Combo', setting: 'clean', format: 'combo', cab: 'open-1x12' },
    { id: 'rig-test-head', amp: 'Test Head', setting: 'crunch', format: 'head' },
    { id: 'rig-test-bad', amp: 'Unknown speaker', setting: 'x', format: 'combo', cab: 'nope' },
  ]);
  assert.equal(getAmpSpec('nam:rig-test-combo').format, 'combo');
  assert.equal(getAmpSpec('nam:rig-test-combo').speakerCab, 'open-1x12');
  assert.equal(getAmpSpec('nam:rig-test-head').format, 'head');
  // An unknown speaker keeps the current cab rather than breaking the rig.
  const start = makeAmpCabConfig('brit-20', 'mesa-2x12-v30');
  assert.equal(withCombo(start, getAmpSpec('nam:rig-test-bad')).cabId, 'mesa-2x12-v30');
});

test('cab drawings know their speaker count', () => {
  assert.equal(speakerCount(getCabSpec('open-1x12')), 1);
  assert.equal(speakerCount(getCabSpec('mesa-2x12-v30')), 2);
  assert.equal(speakerCount(getCabSpec('marshall-4x12-greenback')), 4);
  assert.equal(speakerCount(getCabSpec('direct')), 0);
});
