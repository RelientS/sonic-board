import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EFFECT_SPECS,
  FACTORY_PRESETS,
  formatControlValue,
  getEffectSpec,
  instantiatePreset,
  mapControlValue,
  validateCatalog,
} from '../effects/catalog.ts';

test('catalog contains a complete shoegaze-ready set with valid controls', () => {
  assert.ok(EFFECT_SPECS.length >= 19);
  assert.deepEqual(validateCatalog(EFFECT_SPECS), []);
  assert.ok(new Set(EFFECT_SPECS.map((effect) => effect.category)).size >= 6);
  assert.ok(EFFECT_SPECS.every((effect) => effect.controls.length >= 3));
});

test('classic-inspired effects preserve their defining control layouts', () => {
  assert.deepEqual(getEffectSpec('wall-fuzz').controls.slice(0, 3).map((control) => control.id), ['volume', 'tone', 'sustain']);
  assert.deepEqual(getEffectSpec('rodent-dist').controls.map((control) => control.id), ['distortion', 'filter', 'volume']);
  assert.deepEqual(getEffectSpec('studio-comp').controls.map((control) => control.id), ['level', 'tone', 'attack', 'sustain']);
  assert.equal(getEffectSpec('graphic-eq').controls.length, 8);
  assert.ok(getEffectSpec('reverse-space').controls.some((control) => control.id === 'preDelay'));
  assert.ok(getEffectSpec('reverse-space').controls.some((control) => control.id === 'lowCut'));
});

test('control values map normalized knob positions to physical units', () => {
  const delayTime = getEffectSpec('digital-delay').controls.find((control) => control.id === 'time')!;
  const eqBand = getEffectSpec('graphic-eq').controls.find((control) => control.id === '800')!;
  const phaseRate = getEffectSpec('slow-phase').controls.find((control) => control.id === 'rate')!;

  assert.equal(mapControlValue(delayTime, 0), 40);
  assert.equal(mapControlValue(delayTime, 100), 2000);
  assert.equal(mapControlValue(eqBand, 50), 0);
  assert.equal(formatControlValue(eqBand, 50), '0 dB');
  assert.match(formatControlValue(phaseRate, 45), /Hz$/);
});

test('factory presets cover distinct shoegaze chains and instantiate complete values', () => {
  assert.ok(FACTORY_PRESETS.length >= 6);
  const wall = FACTORY_PRESETS.find((preset) => preset.id === 'reverse-wall')!;
  assert.ok(wall);
  assert.ok(wall.chain.findIndex((item) => item.specId === 'reverse-space') < wall.chain.findIndex((item) => item.specId === 'wall-fuzz'));

  const first = instantiatePreset(wall);
  const second = instantiatePreset(wall);
  assert.equal(first.chain.length, wall.chain.length);
  assert.equal(new Set(first.chain.map((item) => item.instanceId)).size, first.chain.length);
  assert.notDeepEqual(first.chain.map((item) => item.instanceId), second.chain.map((item) => item.instanceId));
  first.chain.forEach((item) => {
    const spec = getEffectSpec(item.specId);
    assert.deepEqual(Object.keys(first.values[item.instanceId]).sort(), spec.controls.map((control) => control.id).sort());
  });
});
