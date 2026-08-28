import assert from 'node:assert/strict';
import test from 'node:test';
import * as audioCore from './audio-core.ts';

import {
  clampParameter,
  encodePcm16Wav,
  estimateTailPolicy,
  estimateTailSeconds,
  EXPORT_DRY_TAIL_SECONDS,
  EXPORT_TAIL_BASE_SECONDS,
  EXPORT_TAIL_KEEP_SECONDS,
  EXPORT_TAIL_SAFETY_CAP_SECONDS,
  EXPORT_TAIL_SILENCE_THRESHOLD,
  getSourceEvents,
  makeDriveCurve,
  makeGateCurve,
  mapDelaySeconds,
  synthesizeSourceChannels,
  trimRenderedTail,
} from './audio-core.ts';
import { getEffectSpec, mapControlValue } from '../effects/catalog.ts';

test('clampParameter keeps pedal values between zero and one hundred', () => {
  assert.equal(clampParameter(-8), 0);
  assert.equal(clampParameter(37), 37);
  assert.equal(clampParameter(108), 100);
});

test('mapDelaySeconds maps the full knob range to a useful echo range', () => {
  assert.equal(mapDelaySeconds(0), 0.08);
  assert.equal(mapDelaySeconds(100), 0.8);
  assert.equal(mapDelaySeconds(50), 0.44);
});

test('makeDriveCurve creates a symmetric bounded waveshaper curve', () => {
  const curve = makeDriveCurve(60, 9);
  assert.equal(curve.length, 9);
  assert.ok(curve[0] < -0.9);
  assert.equal(curve[4], 0);
  assert.ok(curve[8] > 0.9);
  assert.ok(Math.abs(curve[0] + curve[8]) < 0.00001);
});

test('makeGateCurve suppresses low-level signal while preserving loud signal', () => {
  const curve = makeGateCurve(60, 101);
  assert.equal(curve.length, 101);
  assert.ok(Math.abs(curve[51]) < 0.005);
  assert.ok(curve[90] > 0.7);
  assert.ok(Math.abs(curve[10] + curve[90]) < 0.00001);
});

test('noise gate fallback honors its dB threshold without erasing clean guitar level', () => {
  assert.ok('makeNoiseGateCurve' in audioCore, 'noise gate needs a dB-calibrated fallback curve');
  const makeNoiseGateCurve = (audioCore as typeof audioCore & {
    makeNoiseGateCurve: (thresholdDb: number, length?: number) => Float32Array;
  }).makeNoiseGateCurve;
  const curve = makeNoiseGateCurve(-55, 65_537);
  const mapSample = (sample: number) => {
    const position = (sample + 1) * 0.5 * (curve.length - 1);
    const low = Math.floor(position);
    const fraction = position - low;
    return curve[low] * (1 - fraction) + curve[Math.min(curve.length - 1, low + 1)] * fraction;
  };

  assert.ok(mapSample(0.05) > 0.047, 'a -26 dB clean note should pass a -55 dB threshold');
  assert.ok(mapSample(0.0002) < 0.00005, 'sub-threshold noise should be strongly attenuated');
});

test('getSourceEvents returns different fixed performances for each source', () => {
  const chords = getSourceEvents('chords');
  const arpeggio = getSourceEvents('arpeggio');
  const lead = getSourceEvents('lead');

  assert.ok(chords.length >= 12);
  assert.ok(arpeggio.length > chords.length);
  assert.ok(lead.length > 0);
  assert.notDeepEqual(arpeggio, lead);
  assert.ok([...chords, ...arpeggio, ...lead].every((event) => event.time >= 0 && event.duration > 0));
});

test('encodePcm16Wav writes a valid stereo WAV header and payload size', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -0.5, 0.5, -1]);
  const wav = encodePcm16Wav([left, right], 44_100);
  const view = new DataView(wav);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(wav, offset, length));

  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44_100);
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(wav.byteLength, 60);
});

test('synthesizeSourceChannels creates a deterministic stereo clean performance', () => {
  const first = synthesizeSourceChannels('arpeggio', 8_000);
  const second = synthesizeSourceChannels('arpeggio', 8_000);

  assert.equal(first.length, 2);
  assert.equal(first[0].length, first[1].length);
  assert.ok(first[0].length >= 48_000);
  assert.ok(first[0].some((sample) => Math.abs(sample) > 0.01));
  assert.deepEqual(first[0].slice(0, 512), second[0].slice(0, 512));
  assert.ok(first.every((channel) => channel.every((sample) => sample >= -1 && sample <= 1)));
});

test('trimRenderedTail removes inaudible wet padding while keeping channels aligned', () => {
  const left = new Float32Array([0.2, 0.04, 0.00001, 0, 0, 0]);
  const right = new Float32Array([0.1, 0.03, 0.00002, 0, 0, 0]);
  const trimmed = trimRenderedTail([left, right], 10, {
    threshold: EXPORT_TAIL_SILENCE_THRESHOLD,
    keepSeconds: EXPORT_TAIL_KEEP_SECONDS,
  });

  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].length, 4);
  assert.equal(trimmed[1].length, 4);
  assert.deepEqual(trimmed[0], new Float32Array([0.2, 0.04, 0.00001, 0]));
  assert.deepEqual(trimmed[1], new Float32Array([0.1, 0.03, 0.00002, 0]));
});

test('estimateTailSeconds follows active delay and reverb settings', () => {
  const chain = [
    { instanceId: 'echo-1', specId: 'tape-echo' },
    { instanceId: 'hall-1', specId: 'cloud-hall' },
  ];
  const values = {
    'echo-1': { time: 80, repeats: 70, mix: 40 },
    'hall-1': { decay: 90, motion: 30, mix: 50 },
  };

  assert.ok(estimateTailSeconds(chain, values, new Set()) >= 5);
  assert.ok(estimateTailSeconds(chain, values, new Set(['hall-1'])) >= 2);
  assert.equal(estimateTailSeconds([], {}, new Set()), 0.25);
});

test('estimateTailSeconds covers every delay and space family in the expanded catalog', () => {
  const chain = [
    { instanceId: 'analog-1', specId: 'analog-delay' },
    { instanceId: 'dm2-1', specId: 'dm2-delay' },
    { instanceId: 'digital-1', specId: 'digital-delay' },
    { instanceId: 'gate-1', specId: 'gated-room' },
  ];
  const values = {
    'analog-1': { time: 80, feedback: 70 },
    'dm2-1': { time: 72, repeats: 68 },
    'digital-1': { time: 76, feedback: 78 },
    'gate-1': { decay: 70, hold: 60, release: 55 },
  };

  assert.ok(estimateTailSeconds(chain, values, new Set()) >= 5);
  assert.ok(estimateTailSeconds(chain, values, new Set(['digital-1'])) >= 2);
  assert.ok(estimateTailSeconds(chain, values, new Set(['analog-1', 'digital-1', 'gate-1'])) >= 0.5);
});

function controlKnob(specId: string, values: Record<string, number>, controlId: string) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === controlId);
  assert.ok(control, `missing control ${specId}.${controlId}`);
  return clampParameter(values[controlId] ?? control.defaultValue);
}

function controlPhysical(specId: string, values: Record<string, number>, controlId: string) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === controlId);
  assert.ok(control, `missing control ${specId}.${controlId}`);
  return mapControlValue(control, controlKnob(specId, values, controlId));
}

function expectedDelayTail(specId: string, values: Record<string, number>) {
  const time = controlPhysical(specId, values, 'time') / 1000;
  const feedbackId = specId === 'dm2-delay' || specId === 'tape-echo' ? 'repeats' : 'feedback';
  const feedbackKnob = controlKnob(specId, values, feedbackId);
  const feedback = specId === 'digital-delay'
    ? Math.min(0.84, feedbackKnob / 110)
    : Math.min(0.78, feedbackKnob / 112);
  const repeats = feedback <= 0.01 ? 1 : Math.max(1, Math.log(0.01) / Math.log(feedback));
  return time * (specId === 'digital-delay' ? 1.013 : 1) * repeats;
}

function expectedSpaceTail(specId: string, values: Record<string, number>) {
  if (specId === 'gated-room') {
    const impulse = Math.min(8,
      controlPhysical(specId, values, 'decay')
      + controlPhysical(specId, values, 'hold') / 1000
      + controlPhysical(specId, values, 'release') / 1000);
    return 0.008 + impulse;
  }
  return Math.min(10, controlPhysical(specId, values, 'decay'))
    + Math.min(1, controlPhysical(specId, values, 'preDelay') / 1000);
}

function oneEffectPolicy(specId: string, values: Record<string, number>) {
  return estimateTailPolicy(
    [{ instanceId: `${specId}-1`, specId }],
    { [`${specId}-1`]: values },
    new Set(),
  );
}

test('delay support follows catalog boundaries at 0, 50, and 100', () => {
  const delays = [
    { specId: 'analog-delay', feedbackId: 'feedback' },
    { specId: 'dm2-delay', feedbackId: 'repeats' },
    { specId: 'tape-echo', feedbackId: 'repeats' },
    { specId: 'digital-delay', feedbackId: 'feedback' },
  ];

  for (const { specId, feedbackId } of delays) {
    for (const controlId of ['time', feedbackId]) {
      for (const boundary of [0, 50, 100]) {
        const values = { time: 50, [feedbackId]: 80, mix: 100, [controlId]: boundary };
        const expected = Number(Math.max(EXPORT_TAIL_BASE_SECONDS, expectedDelayTail(specId, values)).toFixed(2));
        assert.equal(oneEffectPolicy(specId, values).uncappedSeconds, expected, `${specId}.${controlId}=${boundary}`);
      }
    }
  }
});

test('space support includes catalog IR and pre-delay boundaries', () => {
  const spaces = [
    { specId: 'reverse-space', controls: ['decay', 'preDelay'] },
    { specId: 'gated-room', controls: ['decay', 'hold', 'release'] },
    { specId: 'cloud-hall', controls: ['decay', 'preDelay'] },
  ];

  for (const { specId, controls } of spaces) {
    for (const controlId of controls) {
      for (const boundary of [0, 50, 100]) {
        const values = { decay: 50, preDelay: 50, hold: 50, release: 50, mix: 100, [controlId]: boundary };
        const expected = Number(Math.max(EXPORT_TAIL_BASE_SECONDS, expectedSpaceTail(specId, values)).toFixed(2));
        assert.equal(oneEffectPolicy(specId, values).uncappedSeconds, expected, `${specId}.${controlId}=${boundary}`);
      }
    }
  }
});

test('delay and space mix boundaries suppress support only at zero', () => {
  const ids = [
    'analog-delay', 'dm2-delay', 'tape-echo', 'digital-delay',
    'reverse-space', 'gated-room', 'cloud-hall',
  ];

  for (const specId of ids) {
    const defaults = Object.fromEntries(getEffectSpec(specId).controls.map((control) => [control.id, control.defaultValue]));
    const zero = oneEffectPolicy(specId, { ...defaults, mix: 0 });
    const half = oneEffectPolicy(specId, { ...defaults, mix: 50 });
    const full = oneEffectPolicy(specId, { ...defaults, mix: 100 });
    assert.equal(zero.uncappedSeconds, EXPORT_TAIL_BASE_SECONDS, `${specId}.mix=0`);
    assert.ok(half.uncappedSeconds > EXPORT_TAIL_BASE_SECONDS, `${specId}.mix=50`);
    assert.equal(full.uncappedSeconds, half.uncappedSeconds, `${specId}.mix=100`);
  }
});

test('serial tails add while parallel tails take the longest active lane', () => {
  const chain = [
    { instanceId: 'delay-a', specId: 'analog-delay', lane: 'A' as const },
    { instanceId: 'hall-b', specId: 'cloud-hall', lane: 'B' as const },
  ];
  const values = {
    'delay-a': { time: 80, feedback: 70, mix: 100 },
    'hall-b': { decay: 70, preDelay: 50, mix: 100 },
  };
  const delay = oneEffectPolicy('analog-delay', values['delay-a']).uncappedSeconds;
  const hall = oneEffectPolicy('cloud-hall', values['hall-b']).uncappedSeconds;
  const serial = estimateTailPolicy(chain, values, new Set(), {
    routing: { mode: 'serial', blend: 50, spread: 0 },
  });
  const parallel = estimateTailPolicy(chain, values, new Set(), {
    routing: { mode: 'parallel', blend: 50, spread: 80 },
  });

  assert.ok(Math.abs(serial.uncappedSeconds - (delay + hall)) <= 0.02);
  assert.equal(parallel.uncappedSeconds, Math.max(delay, hall));
});

test('bypass, zero mix, muted lanes, and dry mode do not reserve wet tails', () => {
  const chain = [
    { instanceId: 'delay-a', specId: 'digital-delay', lane: 'A' as const },
    { instanceId: 'hall-b', specId: 'cloud-hall', lane: 'B' as const },
  ];
  const values = {
    'delay-a': { time: 100, feedback: 100, mix: 0 },
    'hall-b': { decay: 100, preDelay: 100, mix: 100 },
  };

  assert.equal(estimateTailSeconds(chain, values, new Set(['hall-b'])), EXPORT_TAIL_BASE_SECONDS);
  assert.equal(estimateTailSeconds(chain, values, new Set(), {
    routing: { mode: 'parallel', blend: 0, spread: 80 },
  }), EXPORT_TAIL_BASE_SECONDS);
  assert.equal(estimateTailSeconds(chain, values, new Set(), {
    mode: 'dry',
    routing: { mode: 'serial', blend: 50, spread: 0 },
  }), EXPORT_DRY_TAIL_SECONDS);
});

test('tail cap is explicit and reports when practical support is truncated', () => {
  const policy = oneEffectPolicy('digital-delay', { time: 100, feedback: 100, mix: 100 });

  assert.ok(policy.uncappedSeconds > EXPORT_TAIL_SAFETY_CAP_SECONDS);
  assert.equal(policy.seconds, EXPORT_TAIL_SAFETY_CAP_SECONDS);
  assert.equal(policy.capSeconds, EXPORT_TAIL_SAFETY_CAP_SECONDS);
  assert.equal(policy.capped, true);
  assert.equal(policy.policy, 'safety-cap');
});
