import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { getSourceEvents } from './audio-core.ts';
import { CHORD_PROGRESSIONS, GUITAR_VOICES, PERFORMANCE_SPECS, makeSourceConfig } from './source-catalog.ts';
import {
  REAL_GUITAR_SAMPLE_BANKS,
  applySampleInputHeadroom,
  makeSamplePlaybackPlan,
} from './sample-library.ts';

test('every guitar choice is backed by a redistributable real multi-sample bank', () => {
  GUITAR_VOICES.forEach((voice) => {
    const bank = REAL_GUITAR_SAMPLE_BANKS[voice.id];
    assert.ok(bank, voice.id);
    assert.equal(bank.license, 'CC0 1.0');
    assert.equal((bank as typeof bank & { signal?: string }).signal, 'raw-di');
    assert.equal(bank.source, 'FreePats Electric Guitar Direct');
    assert.ok((bank as typeof bank & { highCutHz?: number }).highCutHz! >= 4_000);
    assert.ok(bank.instrument.length > 3);
    assert.ok(bank.samples.length >= 6);
    bank.samples.forEach((sample) => {
      assert.match(sample.url, /^\/audio\/guitars\/fender-direct-.+\.wav$/);
      const file = new URL(`../../public${sample.url}`, import.meta.url);
      assert.ok(existsSync(file), sample.url);
      const bytes = readFileSync(file).subarray(0, 12);
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
    });
  });
  assert.equal(new Set(Object.values(REAL_GUITAR_SAMPLE_BANKS).map((bank) => (
    bank as typeof bank & { highCutHz?: number }
  ).highCutHz)).size, 4);
});

test('every performance stays within two semitones of a raw DI root sample', () => {
  GUITAR_VOICES.forEach((voice) => PERFORMANCE_SPECS.forEach((performance) => CHORD_PROGRESSIONS.forEach((progression) => {
    const source = makeSourceConfig(performance.id, voice.id, progression.id);
    const events = getSourceEvents(source);
    const plan = makeSamplePlaybackPlan(source);
    assert.equal(plan.length, events.length);
    assert.ok(plan.every((item) => item.playbackRate >= 0.89 && item.playbackRate <= 1.123), `${voice.name} · ${performance.name} · ${progression.name}`);
    assert.ok(new Set(plan.map((item) => item.sample.url)).size >= 4);
  })));
});

test('source picker names the recorded instruments instead of synthetic pickup profiles', () => {
  assert.deepEqual(GUITAR_VOICES.map((voice) => voice.name), [
    'Fender DI Soft',
    'Fender DI Balanced',
    'Fender DI Picked',
    'Fender DI Dark',
  ]);
  assert.ok(GUITAR_VOICES.every((voice) => voice.description.includes('真实采样')));
});

test('real sample mixes are reduced to clean amp-input headroom without boosting quiet sources', () => {
  const loud = [new Float32Array([0.1, -0.8, 0.4]), new Float32Array([0.2, 0.6, -0.3])];
  const appliedGain = applySampleInputHeadroom(loud);
  const resultingPeak = Math.max(...loud.flatMap((channel) => [...channel].map(Math.abs)));
  assert.ok(appliedGain < 0.23);
  assert.ok(resultingPeak <= 0.18);

  const quiet = [new Float32Array([0.05, -0.1])];
  assert.equal(applySampleInputHeadroom(quiet), 1);
  assert.deepEqual([...quiet[0]], [0.05000000074505806, -0.10000000149011612]);
});
