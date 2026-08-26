import assert from 'node:assert/strict';
import test from 'node:test';

import { EFFECT_SPECS } from '../effects/catalog.ts';
import { planToneRequest } from '../agent/tone-agent.ts';

test('tone agent builds a wide reverse wall with protected mids', () => {
  const plan = planToneRequest('想要宽阔立体声的反向音墙，用扫弦和弦，厚但中频别丢');
  const ids = plan.preset.chain.map((item) => item.specId);
  assert.equal(plan.preset.routing.mode, 'parallel');
  assert.ok(ids.indexOf('reverse-space') < ids.indexOf('wall-fuzz'));
  assert.ok(ids.includes('graphic-eq'));
  assert.equal(plan.preset.source.performance, 'chords');
  assert.equal(plan.preset.source.guitar, 'humbucker');
  assert.ok(plan.decisions.length >= 3);
});

test('tone agent understands clean bright arpeggios and named effects', () => {
  const plan = planToneRequest('干净明亮的分解和弦，要模拟合唱、磁带回声和长混响');
  const ids = plan.preset.chain.map((item) => item.specId);
  assert.equal(plan.preset.source.performance, 'arpeggio');
  assert.equal(plan.preset.source.guitar, 'single-bridge');
  assert.ok(ids.includes('analog-chorus'));
  assert.ok(ids.includes('tape-echo'));
  assert.ok(ids.includes('cloud-hall'));
  assert.ok(!ids.includes('wall-fuzz'));
});

test('tone agent keeps every generated board valid and bounded', () => {
  const available = new Set(EFFECT_SPECS.map((effect) => effect.id));
  const requests = [
    '很凶的噪音单音，门限快速收尾',
    '温暖复古的小调和弦，慢速相位和磁带感',
    '空气感清音，左右很宽，分解和弦',
    '',
  ];

  requests.forEach((request) => {
    const plan = planToneRequest(request);
    assert.ok(plan.preset.chain.length >= 3 && plan.preset.chain.length <= 8);
    plan.preset.chain.forEach((item) => {
      assert.ok(available.has(item.specId), item.specId);
      Object.values(item.settings ?? {}).forEach((value) => assert.ok(value >= 0 && value <= 100));
    });
  });
});
