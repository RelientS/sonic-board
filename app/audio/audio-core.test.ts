import assert from 'node:assert/strict';
import test from 'node:test';
import * as audioCore from './audio-core.ts';

import {
  clampParameter,
  encodePcm16Wav,
  estimateTailSeconds,
  getSourceEvents,
  makeDriveCurve,
  makeGateCurve,
  mapDelaySeconds,
  synthesizeSourceChannels,
} from './audio-core.ts';

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
    { instanceId: 'digital-1', specId: 'digital-delay' },
    { instanceId: 'gate-1', specId: 'gated-room' },
  ];
  const values = {
    'analog-1': { time: 80, feedback: 70 },
    'digital-1': { time: 76, feedback: 78 },
    'gate-1': { decay: 70, hold: 60, release: 55 },
  };

  assert.ok(estimateTailSeconds(chain, values, new Set()) >= 5);
  assert.ok(estimateTailSeconds(chain, values, new Set(['digital-1'])) >= 2);
});
