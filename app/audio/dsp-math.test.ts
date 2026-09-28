import assert from 'node:assert/strict';
import test from 'node:test';

import { fftInPlace, minimumPhaseImpulse, speakerMagnitude, type SpeakerVoicing } from './dsp-math.ts';

function magnitudeOf(impulse: Float64Array, n: number) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(impulse.subarray(0, n));
  fftInPlace(re, im);
  return Array.from({ length: n / 2 + 1 }, (_, k) => Math.hypot(re[k], im[k]));
}

test('fft round trip reproduces the input', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + (i % 5) * 0.1);
  const original = Float64Array.from(re);
  const im = new Float64Array(n);
  fftInPlace(re, im);
  fftInPlace(re, im, true);
  re.forEach((value, i) => assert.ok(Math.abs(value - original[i]) < 1e-9));
});

test('a flat magnitude gives a unit impulse', () => {
  const n = 256;
  const impulse = minimumPhaseImpulse(new Float64Array(n / 2 + 1).fill(1), n);
  assert.ok(Math.abs(impulse[0] - 1) < 1e-9);
  for (let i = 1; i < n; i += 1) assert.ok(Math.abs(impulse[i]) < 1e-9);
});

test('minimum-phase design matches the target magnitude and front-loads energy', () => {
  const n = 4096;
  const voicing: SpeakerVoicing = {
    resonanceHz: 95, resonanceQ: 1.3, openBackHz: 0, bodyHz: 125, bodyGain: 4, presenceHz: 2_900, presenceGain: 2, highCut: 5_000, seed: 7,
  };
  const target = speakerMagnitude(voicing, { position: 48, distance: 18 }, 48_000, n);
  const impulse = minimumPhaseImpulse(target, n);
  const actual = magnitudeOf(impulse, n);
  for (const hz of [80, 150, 1_000, 3_000, 6_000]) {
    const k = Math.round((hz * n) / 48_000);
    const errorDb = 20 * Math.log10(actual[k] / target[k]);
    assert.ok(Math.abs(errorDb) < 0.1, `${hz} Hz off by ${errorDb.toFixed(3)} dB`);
  }
  const energy = (from: number, to: number) => impulse.slice(from, to).reduce((sum, x) => sum + x * x, 0);
  assert.ok(energy(0, 480) / energy(0, n) > 0.95, 'a speaker response settles within 10 ms');
});

test('speaker model is a guitar cab: steep top-end roll-off, bass resonance, level normalized at 1 kHz', () => {
  const n = 4096;
  const voicing: SpeakerVoicing = {
    resonanceHz: 95, resonanceQ: 1.3, openBackHz: 0, bodyHz: 125, bodyGain: 4, presenceHz: 2_900, presenceGain: 2, highCut: 5_000, seed: 7,
  };
  const at = (magnitude: Float64Array, hz: number) => 20 * Math.log10(magnitude[Math.round((hz * n) / 48_000)]);
  const onAxis = speakerMagnitude(voicing, { position: 0, distance: 0 }, 48_000, n);
  const edge = speakerMagnitude(voicing, { position: 100, distance: 100 }, 48_000, n);
  assert.ok(Math.abs(at(onAxis, 1_000)) < 1e-6);
  assert.ok(at(onAxis, 12_000) < -25, 'guitar speakers are far down at 12 kHz');
  assert.ok(at(onAxis, 40) < -10, 'below resonance the cab rolls off');
  assert.ok(at(edge, 4_500) < at(onAxis, 4_500) - 3, 'moving the mic off-axis darkens the top');
});
