import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EFFECT_SPECS,
  FACTORY_PRESETS,
  STYLE_TAG_LABELS,
  STYLE_TAGS,
  formatControlValue,
  getEffectSearchText,
  getEffectSpec,
  getPresetSearchText,
  instantiatePreset,
  mapControlValue,
  validateCatalog,
  validateFactoryPresets,
} from '../effects/catalog.ts';

test('catalog contains a complete multi-style set with valid controls and metadata', () => {
  assert.ok(EFFECT_SPECS.length >= 26);
  assert.deepEqual(validateCatalog(EFFECT_SPECS), []);
  assert.deepEqual(validateFactoryPresets(FACTORY_PRESETS), []);
  assert.ok(new Set(EFFECT_SPECS.map((effect) => effect.category)).size >= 6);
  assert.ok(EFFECT_SPECS.every((effect) => effect.controls.length >= 1));
  assert.ok(EFFECT_SPECS.every((effect) => effect.searchTerms?.length));
  assert.ok(EFFECT_SPECS.every((effect) => effect.styleTags?.length));
  assert.ok(FACTORY_PRESETS.every((preset) => preset.styleTags?.length));
});

test('discovery metadata covers bilingual style and use vocabulary', () => {
  const effectText = EFFECT_SPECS.map(getEffectSearchText).join(' ').toLowerCase();
  const presetText = FACTORY_PRESETS.map(getPresetSearchText).join(' ').toLowerCase();
  const requiredPairs = [
    ['clean', '清音'],
    ['blues', '布鲁斯'],
    ['indie', '独立'],
    ['funk', '放克'],
    ['metal', '金属'],
    ['shoegaze', '盯鞋'],
    ['ambient', '氛围'],
    ['rhythm', '节奏'],
    ['experimental', '实验'],
  ];

  requiredPairs.forEach(([english, chinese]) => {
    assert.match(effectText, new RegExp(english));
    assert.match(effectText, new RegExp(chinese));
    assert.match(presetText, new RegExp(english));
  });
  ['compression', 'chorus', 'delay', 'gate', 'fuzz', 'overdrive', 'space'].forEach((term) => assert.match(effectText, new RegExp(term)));
  assert.equal(STYLE_TAGS.length, requiredPairs.length);
  STYLE_TAGS.forEach((tag) => assert.ok(STYLE_TAG_LABELS[tag].length >= 2));
});

test('classic-inspired effects preserve their defining control layouts', () => {
  assert.deepEqual(getEffectSpec('wall-fuzz').controls.map((control) => control.id), ['volume', 'tone', 'sustain']);
  assert.deepEqual(getEffectSpec('rodent-dist').controls.map((control) => control.id), ['distortion', 'filter', 'volume']);
  assert.deepEqual(getEffectSpec('studio-comp').controls.map((control) => control.id), ['level', 'sustain']);
  assert.deepEqual(getEffectSpec('analog-delay').controls.map((control) => control.id), ['time', 'feedback', 'mix']);
  assert.deepEqual(getEffectSpec('analog-chorus').controls.map((control) => control.id), ['rate', 'depth']);
  assert.deepEqual(getEffectSpec('fuzz-face').controls.map((control) => control.id), ['fuzz', 'volume']);
  assert.deepEqual(getEffectSpec('phase90').controls.map((control) => control.id), ['speed']);
  assert.equal(getEffectSpec('graphic-eq').controls.length, 8);
  assert.ok(getEffectSpec('reverse-space').controls.some((control) => control.id === 'preDelay'));
  assert.ok(getEffectSpec('reverse-space').controls.some((control) => control.id === 'lowCut'));
});

test('pedals use the classic model names shown on the physical board', () => {
  assert.equal(getEffectSpec('studio-comp').name, 'MXR Dyna Comp');
  assert.equal(getEffectSpec('blue-drive').name, 'Boss BD-2 Blues Driver');
  assert.equal(getEffectSpec('rodent-dist').name, 'Pro Co RAT 2');
  assert.equal(getEffectSpec('wall-fuzz').name, 'Electro-Harmonix Big Muff Pi');
  assert.equal(getEffectSpec('slow-phase').name, 'Electro-Harmonix Small Stone');
  assert.equal(getEffectSpec('analog-chorus').name, 'Boss CE-2 Chorus');
  assert.equal(getEffectSpec('dm2-delay').name, 'Boss DM-2 Delay');
  assert.equal(getEffectSpec('fuzz-face').name, 'Dallas-Arbiter Fuzz Face');
  assert.equal(getEffectSpec('ocd-drive').name, 'Fulltone OCD');
  assert.equal(getEffectSpec('klon-centaur').name, 'Klon Centaur');
  assert.equal(getEffectSpec('sd1-drive').name, 'Boss SD-1 Super OverDrive');
  assert.equal(getEffectSpec('tube-screamer').name, 'Ibanez TS808 Tube Screamer');
  assert.equal(getEffectSpec('phase90').name, 'MXR Phase 90');
  assert.equal(getEffectSpec('reverse-space').name, 'Yamaha SPX90 Reverse Gate');
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

test('factory presets cover distinct style chains and instantiate complete values', () => {
  assert.ok(FACTORY_PRESETS.length >= 9);
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

  const jetCloud = FACTORY_PRESETS.find((preset) => preset.id === 'jet-cloud')!;
  const jetDrive = jetCloud.chain.find((item) => item.specId === 'blue-drive');
  assert.ok((jetDrive?.settings?.level ?? 0) >= 80, 'jet-cloud should keep enough drive output for an audible ambient starting point');

  const stereo = FACTORY_PRESETS.find((preset) => preset.id === 'stereo-bloom')!;
  assert.equal(stereo.routing.mode, 'parallel');
  assert.ok(stereo.chain.some((item) => item.lane === 'A'));
  assert.ok(stereo.chain.some((item) => item.lane === 'B'));
  const instantiatedStereo = instantiatePreset(stereo);
  assert.equal(instantiatedStereo.routing.mode, 'parallel');
  assert.equal(instantiatedStereo.amp.ampId, stereo.amp.ampId);
});
