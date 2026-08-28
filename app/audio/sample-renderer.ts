import { SOURCE_DURATION_SECONDS } from './audio-core.ts';
import { REAL_GUITAR_SAMPLE_BANKS, applySampleInputHeadroom, makeSamplePlaybackPlan } from './sample-library.ts';
import { type SourceConfig } from './source-catalog.ts';

// A render uses at most eleven roots; retain a little room without keeping all 48 files.
export const MAX_ENCODED_SAMPLE_CACHE_ENTRIES = 16;

const encodedSampleCache = new Map<string, ArrayBuffer>();
const inFlightSampleFetches = new Map<string, Promise<ArrayBuffer>>();

function rememberEncodedSample(url: string, encoded: ArrayBuffer) {
  encodedSampleCache.delete(url);
  encodedSampleCache.set(url, encoded);
  while (encodedSampleCache.size > MAX_ENCODED_SAMPLE_CACHE_ENTRIES) {
    const oldest = encodedSampleCache.keys().next().value;
    if (oldest === undefined) break;
    encodedSampleCache.delete(oldest);
  }
}

export function getEncodedSampleCacheSize() {
  return encodedSampleCache.size;
}

function fetchSample(url: string) {
  const cached = encodedSampleCache.get(url);
  if (cached !== undefined) {
    rememberEncodedSample(url, cached);
    return Promise.resolve(cached);
  }

  const inFlight = inFlightSampleFetches.get(url);
  if (inFlight) return inFlight;

  const pending = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`采样加载失败：${response.status} ${url}`);
      return response.arrayBuffer();
    })
    .then((encoded) => {
      rememberEncodedSample(url, encoded);
      return encoded;
    });
  inFlightSampleFetches.set(url, pending);
  void pending.then(
    () => {
      if (inFlightSampleFetches.get(url) === pending) inFlightSampleFetches.delete(url);
    },
    () => {
      if (inFlightSampleFetches.get(url) === pending) inFlightSampleFetches.delete(url);
    },
  );
  return pending;
}

export async function renderSampledSourceBuffer(
  context: BaseAudioContext,
  sourceConfig: SourceConfig,
) {
  const plan = makeSamplePlaybackPlan(sourceConfig);
  const bank = REAL_GUITAR_SAMPLE_BANKS[sourceConfig.guitar];
  const offline = new OfflineAudioContext(
    2,
    Math.ceil(SOURCE_DURATION_SECONDS * context.sampleRate),
    context.sampleRate,
  );
  const sampleUrls = [...new Set(plan.map((event) => event.sample.url))];
  const decoded = new Map<string, AudioBuffer>();

  await Promise.all(sampleUrls.map(async (url) => {
    const encoded = await fetchSample(url);
    decoded.set(url, await offline.decodeAudioData(encoded.slice(0)));
  }));

  plan.forEach((event) => {
    const buffer = decoded.get(event.sample.url);
    if (!buffer) return;
    const player = offline.createBufferSource();
    const envelope = offline.createGain();
    const tone = offline.createBiquadFilter();
    const panner = offline.createStereoPanner();
    const start = event.time;
    const end = Math.min(SOURCE_DURATION_SECONDS, start + event.duration);
    const attackEnd = Math.min(end, start + 0.008);
    const releaseStart = Math.max(attackEnd, end - Math.min(0.12, event.duration * 0.22));

    player.buffer = buffer;
    player.playbackRate.value = event.playbackRate;
    envelope.gain.setValueAtTime(0.0001, start);
    const peak = Math.max(0.0001, event.velocity * 0.32);
    envelope.gain.exponentialRampToValueAtTime(peak, attackEnd);
    envelope.gain.setValueAtTime(peak, releaseStart);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    tone.type = 'lowpass';
    tone.frequency.value = bank.highCutHz;
    tone.Q.value = 0.42;
    panner.pan.value = event.pan;
    player.connect(envelope).connect(tone).connect(panner).connect(offline.destination);
    player.start(start);
    player.stop(Math.min(SOURCE_DURATION_SECONDS, end + 0.02));
  });

  const rendered = await offline.startRendering();
  applySampleInputHeadroom(
    Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index)),
  );
  return rendered;
}
