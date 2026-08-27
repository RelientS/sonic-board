import assert from 'node:assert/strict';
import test from 'node:test';

import { EFFECT_SPECS } from '../effects/catalog.ts';
import { getPedalControlLabel } from '../effects/control-labels.ts';

test('every pedal control has a compact English silk-screen label', () => {
  EFFECT_SPECS.forEach((effect) => {
    effect.controls.forEach((control) => {
      const label = getPedalControlLabel(effect.id, control.id);
      assert.match(label, /^[A-Z0-9 .-]+$/, `${effect.id}.${control.id}`);
      assert.ok(label.length <= 8, `${effect.id}.${control.id} should fit on the pedal`);
    });
  });
});

test('classic pedal controls use familiar abbreviations', () => {
  assert.equal(getPedalControlLabel('studio-comp', 'sustain'), 'SENS');
  assert.equal(getPedalControlLabel('wall-fuzz', 'volume'), 'VOL');
  assert.equal(getPedalControlLabel('wall-fuzz', 'tone'), 'TONE');
  assert.equal(getPedalControlLabel('digital-delay', 'feedback'), 'FDBK');
  assert.equal(getPedalControlLabel('reverse-space', 'preDelay'), 'PRE-DLY');
  assert.equal(getPedalControlLabel('graphic-eq', '1600'), '1.6K');
});
