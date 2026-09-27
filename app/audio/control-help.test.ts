import assert from 'node:assert/strict';
import test from 'node:test';

import { AMP_SPECS, CAB_SPECS } from '../amps/catalog.ts';
import { getControlHelp } from '../effects/control-help.ts';
import { EFFECT_SPECS } from '../effects/catalog.ts';

test('every exposed effect, amp and cabinet control has a complete Chinese lesson', () => {
  const entries = [
    ...EFFECT_SPECS.flatMap((model) => model.controls.map((control) => ({ kind: 'effect' as const, model, control }))),
    ...AMP_SPECS.flatMap((model) => model.controls.map((control) => ({ kind: 'amp' as const, model, control }))),
    ...CAB_SPECS.flatMap((model) => model.controls.map((control) => ({ kind: 'cab' as const, model, control }))),
  ];

  entries.forEach(({ kind, model, control }) => {
    const lesson = getControlHelp(kind, model.id, control);
    assert.ok(lesson.summary.length >= 8, `${model.id}.${control.id} summary`);
    assert.ok(lesson.low.length >= 4, `${model.id}.${control.id} low`);
    assert.ok(lesson.high.length >= 4, `${model.id}.${control.id} high`);
    assert.ok(lesson.tip.length >= 6, `${model.id}.${control.id} tip`);
    assert.match(lesson.range, new RegExp(String(control.min)));
    assert.match(lesson.range, new RegExp(String(control.max)));
  });
});

test('lessons explain context-specific behavior instead of only repeating the label', () => {
  const fuzzTone = EFFECT_SPECS.find((model) => model.id === 'wall-fuzz')!.controls.find((control) => control.id === 'tone')!;
  const reversePreDelay = EFFECT_SPECS.find((model) => model.id === 'reverse-space')!.controls.find((control) => control.id === 'preDelay')!;
  const ampGain = AMP_SPECS.find((model) => model.id === 'brit-20')!.controls.find((control) => control.id === 'gain')!;
  const micPosition = CAB_SPECS.find((model) => model.id === 'closed-4x12')!.controls.find((control) => control.id === 'position')!;

  assert.match(getControlHelp('effect', 'wall-fuzz', fuzzTone).summary, /高频|截止/);
  assert.match(getControlHelp('effect', 'reverse-space', reversePreDelay).summary, /干声|混响/);
  assert.match(getControlHelp('amp', 'brit-20', ampGain).summary, /前级|失真/);
  assert.match(getControlHelp('cab', 'closed-4x12', micPosition).summary, /中心|边缘|麦克风/);
});

test('style-specific lessons give useful starting points beyond shoegaze', () => {
  const cases = [
    ['studio-comp', 'sustain', /清音|布鲁斯|放克/],
    ['fuzz-face', 'fuzz', /布鲁斯|清理/],
    ['chainsaw-dist', 'distortion', /金属|节奏/],
    ['bias-tremolo', 'rate', /放克|节奏/],
    ['cloud-hall', 'decay', /氛围|盯鞋/],
  ] as const;

  cases.forEach(([modelId, controlId, expression]) => {
    const control = EFFECT_SPECS.find((model) => model.id === modelId)!.controls.find((entry) => entry.id === controlId)!;
    const lesson = getControlHelp('effect', modelId, control);
    assert.match(lesson.tip, expression, `${modelId}.${controlId}`);
  });
});
