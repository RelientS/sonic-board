import assert from 'node:assert/strict';
import test from 'node:test';

import { encodePcmWav } from './audio-core.ts';

type Processor = {
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  port: { onmessage: ((event: { data: unknown }) => void) | null };
};
type ProcessorClass = new (options: { processorOptions?: Record<string, number> }) => Processor;

const registered = new Map<string, ProcessorClass>();
const scope = globalThis as unknown as Record<string, unknown>;
scope.sampleRate = 48_000;
scope.AudioWorkletProcessor = class { port = { onmessage: null }; };
scope.registerProcessor = (name: string, cls: ProcessorClass) => { registered.set(name, cls); };
// A worklet script, not a module: load it by URL so it registers into the fake scope.
await import(new URL('../../public/audio/fx-processor.js', import.meta.url).href);

const BLOCK = 128;

/** Runs `frames` of mono input through a processor; returns stereo output. */
function run(processor: Processor, input: (n: number) => number, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let start = 0; start < frames; start += BLOCK) {
    const inBlock = Float32Array.from({ length: BLOCK }, (_, i) => input(start + i));
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    processor.process([[inBlock]], [out]);
    left.set(out[0].subarray(0, Math.min(BLOCK, frames - start)), start);
    right.set(out[1].subarray(0, Math.min(BLOCK, frames - start)), start);
  }
  return { left, right };
}

function energyDb(signal: Float32Array, from: number, to: number) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += signal[i] * signal[i];
  return 10 * Math.log10(sum / (to - from) + 1e-30);
}

test('FDN reverb decays at the requested RT60 and darkens as it decays', () => {
  const Reverb = registered.get('sonic-reverb')!;
  const rt60 = 2;
  const reverb = new Reverb({ processorOptions: { decay: rt60, preDelay: 0, tone: 5_000, motion: 0, size: 1 } });
  const { left } = run(reverb, (n) => (n === 0 ? 1 : 0), 48_000 * 3);
  // Energy in 100 ms windows at 0.5 s and 1.5 s: 1 s apart = -30 dB for RT60 2 s.
  const window = 4_800;
  const drop = energyDb(left, 24_000, 24_000 + window) - energyDb(left, 72_000, 72_000 + window);
  assert.ok(drop > 22 && drop < 40, `1 s energy drop ${drop.toFixed(1)} dB, expected ~30 dB`);
  const early = left.slice(4_800, 9_600);
  const late = left.slice(48_000, 52_800);
  const brightness = (x: Float32Array) => {
    let diff = 0;
    let total = 0;
    for (let i = 1; i < x.length; i += 1) {
      diff += (x[i] - x[i - 1]) ** 2;
      total += x[i] ** 2;
    }
    return diff / (total + 1e-30);
  };
  assert.ok(brightness(late) < brightness(early), 'high frequencies decay faster than lows');
  const dispose = reverb.port.onmessage!;
  dispose({ data: { type: 'dispose' } });
  assert.equal(reverb.process([[new Float32Array(BLOCK)]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]]), false);
});

test('flanger reaches sub-millisecond delays with in-line feedback', () => {
  const Flanger = registered.get('sonic-flanger')!;
  const flanger = new Flanger({ processorOptions: { manual: 0, rate: 0.01, depth: 0, feedback: 0 } });
  // Manual 0 = 0.3 ms: an impulse must come out ~14 samples later.
  const { left } = run(flanger, (n) => (n === 0 ? 1 : 0), 256);
  const peakAt = left.reduce((best, value, index) => (Math.abs(value) > Math.abs(left[best]) ? index : best), 0);
  assert.ok(peakAt >= 12 && peakAt <= 16, `impulse delayed by ${peakAt} samples`);
});

test('limiter holds a -1 dBFS true-peak ceiling on a hot signal', () => {
  const Limiter = registered.get('sonic-limiter')!;
  const limiter = new Limiter({ processorOptions: { ceilingDb: -1, releaseMs: 80 } });
  const ceiling = 10 ** (-1 / 20);
  const { left } = run(limiter, (n) => 2.5 * Math.sin((2 * Math.PI * 997 * n) / 48_000), 48_000);
  const steady = left.slice(4_800);
  const peak = steady.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak}`);
  assert.ok(peak > ceiling * 0.9, 'limiting should not crush the level');
});

test('24-bit WAV round-trips samples and 16-bit dither stays within one LSB', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 1e-6]);
  const wav = new DataView(encodePcmWav([samples], 48_000, { bits: 24 }));
  assert.equal(wav.getUint16(34, true), 24);
  const read24 = (i: number) => {
    const offset = 44 + i * 3;
    const value = wav.getUint8(offset) | (wav.getUint8(offset + 1) << 8) | (wav.getInt8(offset + 2) << 16);
    return value / 0x7fffff;
  };
  samples.forEach((sample, i) => assert.ok(Math.abs(read24(i) - Math.max(-1, sample)) < 2 / 0x7fffff));
  let state = 1;
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  const silence = new Float32Array(1_000);
  const dithered = new DataView(encodePcmWav([silence], 48_000, { bits: 16, dither: true, random }));
  for (let i = 0; i < silence.length; i += 1) assert.ok(Math.abs(dithered.getInt16(44 + i * 2, true)) <= 1);
});
