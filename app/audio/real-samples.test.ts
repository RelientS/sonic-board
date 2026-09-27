import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { getSourceEvents } from './audio-core.ts';
import { CHORD_PROGRESSIONS, GUITAR_VOICES, PERFORMANCE_SPECS, makeSourceConfig } from './source-catalog.ts';
import {
  REAL_GUITAR_SAMPLE_BANKS,
  SAMPLE_INPUT_PEAK,
  applySampleInputHeadroom,
  makeSamplePlaybackPlan,
} from './sample-library.ts';
import {
  getEncodedSampleCacheSize,
  MAX_ENCODED_SAMPLE_CACHE_ENTRIES,
  renderSampledSourceBuffer,
} from './sample-renderer.ts';

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
      assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
      assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'WAVE');
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

class FakeAudioParam {
  value = 0;

  setValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeDecodedAudioBuffer {
  readonly numberOfChannels = 1;

  getChannelData() { return new Float32Array([0]); }
}

class FakeRenderedAudioBuffer {
  readonly numberOfChannels = 2;
  private readonly channels = [
    new Float32Array([0.8, -0.4]),
    new Float32Array([0.2, -0.1]),
  ];

  getChannelData(channel: number) { return this.channels[channel]; }
}

class FakeAudioNode {
  buffer: FakeDecodedAudioBuffer | null = null;
  type = '';
  readonly playbackRate = new FakeAudioParam();
  readonly gain = new FakeAudioParam();
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
  readonly pan = new FakeAudioParam();

  connect<T>(target: T) { return target; }
  start() {}
  stop() {}
}

class FakeOfflineAudioContext {
  readonly destination = {};
  readonly channels: number;
  readonly length: number;
  readonly sampleRate: number;

  constructor(channels: number, length: number, sampleRate: number) {
    this.channels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  decodeAudioData() {
    return Promise.resolve(new FakeDecodedAudioBuffer());
  }

  createBufferSource() { return new FakeAudioNode(); }
  createGain() { return new FakeAudioNode(); }
  createBiquadFilter() { return new FakeAudioNode(); }
  createStereoPanner() { return new FakeAudioNode(); }
  startRendering() { return Promise.resolve(new FakeRenderedAudioBuffer()); }
}

test('sample fetches recover after failure and retain a bounded successful LRU', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousFetch = globals.fetch;
  const previousOfflineAudioContext = globals.OfflineAudioContext;
  const source = makeSourceConfig('chords', 'single-neck', 'dream-open');
  const failingUrl = makeSamplePlaybackPlan(source)[0].sample.url;
  const requests: string[] = [];
  let shouldFail = true;

  globals.OfflineAudioContext = FakeOfflineAudioContext;
  globals.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === failingUrl && shouldFail) {
      shouldFail = false;
      throw new Error('temporary sample fetch failure');
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response;
  };

  try {
    const context = { sampleRate: 48_000 } as BaseAudioContext;
    await assert.rejects(
      renderSampledSourceBuffer(context, source),
      /temporary sample fetch failure/,
    );

    const rendered = await renderSampledSourceBuffer(context, source);
    assert.equal(requests.filter((url) => url === failingUrl).length, 2);
    const renderedPeak = Math.max(
      ...Array.from({ length: rendered.numberOfChannels }, (_, index) => (
        [...rendered.getChannelData(index)].map(Math.abs)
      )).flat(),
    );
    assert.ok(renderedPeak <= SAMPLE_INPUT_PEAK);

    for (const voice of GUITAR_VOICES) {
      await renderSampledSourceBuffer(
        context,
        makeSourceConfig('arpeggio', voice.id, 'power-bloom'),
      );
      await renderSampledSourceBuffer(
        context,
        makeSourceConfig('lead', voice.id, 'minor-drift'),
      );
    }

    assert.equal(new Set(requests).size, 48);
    assert.equal(getEncodedSampleCacheSize(), MAX_ENCODED_SAMPLE_CACHE_ENTRIES);

    const requestCount = requests.length;
    await renderSampledSourceBuffer(
      context,
      makeSourceConfig('lead', 'hollowbody', 'minor-drift'),
    );
    assert.equal(requests.length, requestCount, 'recent samples should remain in the LRU');

    const coldRequestCount = requests.length;
    await renderSampledSourceBuffer(
      context,
      makeSourceConfig('lead', 'single-neck', 'minor-drift'),
    );
    assert.ok(requests.length > coldRequestCount, 'old samples should be evicted from the LRU');
  } finally {
    if (previousFetch === undefined) delete globals.fetch;
    else globals.fetch = previousFetch;
    if (previousOfflineAudioContext === undefined) delete globals.OfflineAudioContext;
    else globals.OfflineAudioContext = previousOfflineAudioContext;
  }
});
