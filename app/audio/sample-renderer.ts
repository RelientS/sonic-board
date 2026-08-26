import { SOURCE_DURATION_SECONDS } from './audio-core.ts';
import { applySampleInputHeadroom, makeSamplePlaybackPlan } from './sample-library.ts';
import { type SourceConfig } from './source-catalog.ts';

const encodedSampleCache = new Map<string, Promise<ArrayBuffer>>();

async function fetchSample(url: string) {
  let pending = encodedSampleCache.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`采样加载失败：${response.status} ${url}`);
      return response.arrayBuffer();
    });
    encodedSampleCache.set(url, pending);
  }
  return pending;
}

export async function renderSampledSourceBuffer(
  context: BaseAudioContext,
  sourceConfig: SourceConfig,
) {
  const plan = makeSamplePlaybackPlan(sourceConfig);
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
    panner.pan.value = event.pan;
    player.connect(envelope).connect(panner).connect(offline.destination);
    player.start(start);
    player.stop(Math.min(SOURCE_DURATION_SECONDS, end + 0.02));
  });

  const rendered = await offline.startRendering();
  applySampleInputHeadroom(
    Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index)),
  );
  return rendered;
}
