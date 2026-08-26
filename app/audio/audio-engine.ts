import {
  clampParameter,
  encodePcm16Wav,
  estimateTailSeconds,
  makeDriveCurve,
  mapDelaySeconds,
  SOURCE_DURATION_SECONDS,
  synthesizeSourceChannels,
  type AudioChainItem,
  type AudioValues,
  type SourceKind,
} from './audio-core';

export type BoardAudioConfig = {
  chain: AudioChainItem[];
  values: AudioValues;
  bypassed: string[];
  source: SourceKind;
  mode: 'dry' | 'wet';
  output: number;
};

export type LiveAudioSession = {
  context: AudioContext;
  source: AudioBufferSourceNode | null;
  scheduled: AudioScheduledSourceNode[];
  buffers: Map<SourceKind, AudioBuffer>;
  startedAt: number;
  duration: number;
  sourceKind: SourceKind;
};

function parameter(values: Record<string, number>, id: string, fallback: number) {
  return clampParameter(values[id] ?? fallback);
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

function makeAudioBuffer(context: BaseAudioContext, source: SourceKind) {
  const channels = synthesizeSourceChannels(source, context.sampleRate);
  const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
  channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
  return buffer;
}

function makeImpulse(
  context: BaseAudioContext,
  seconds: number,
  reverse: boolean,
  seed: number,
) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  const random = seededRandom(seed);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const phase = index / length;
      const envelope = reverse ? phase ** 2.2 : (1 - phase) ** 2.5;
      data[index] = random() * envelope * 0.72;
    }
  }

  return buffer;
}

function mixParallel(
  context: BaseAudioContext,
  dryInput: AudioNode,
  wetInput: AudioNode,
  wetAmount: number,
) {
  const sum = context.createGain();
  const dryGain = context.createGain();
  const wetGain = context.createGain();
  const mix = clampParameter(wetAmount) / 100;
  dryGain.gain.value = Math.cos(mix * Math.PI * 0.5);
  wetGain.gain.value = Math.sin(mix * Math.PI * 0.5);
  dryInput.connect(dryGain).connect(sum);
  wetInput.connect(wetGain).connect(sum);
  return sum;
}

function connectEffectChain(
  context: BaseAudioContext,
  input: AudioNode,
  config: BoardAudioConfig,
  scheduled: AudioScheduledSourceNode[],
) {
  if (config.mode === 'dry') return input;

  const bypassed = new Set(config.bypassed);
  let cursor = input;

  config.chain.forEach((item) => {
    if (bypassed.has(item.instanceId)) return;
    const values = config.values[item.instanceId] ?? {};

    if (item.specId === 'wall-fuzz') {
      const preGain = context.createGain();
      const shaper = context.createWaveShaper();
      const tone = context.createBiquadFilter();
      const level = context.createGain();
      preGain.gain.value = 1.2 + parameter(values, 'sustain', 60) / 18;
      shaper.curve = makeDriveCurve(parameter(values, 'sustain', 60));
      shaper.oversample = '4x';
      tone.type = 'lowpass';
      tone.frequency.value = 850 + parameter(values, 'tone', 45) * 58;
      tone.Q.value = 0.72;
      level.gain.value = 0.22 + parameter(values, 'volume', 55) / 105;
      cursor.connect(preGain).connect(shaper).connect(tone).connect(level);
      cursor = level;
      return;
    }

    if (item.specId === 'slow-phase') {
      const first = context.createBiquadFilter();
      const second = context.createBiquadFilter();
      const lfo = context.createOscillator();
      const firstDepth = context.createGain();
      const secondDepth = context.createGain();
      const depth = parameter(values, 'depth', 38);
      first.type = 'allpass';
      second.type = 'allpass';
      first.frequency.value = 520;
      second.frequency.value = 1_150;
      first.Q.value = 0.7 + parameter(values, 'res', 20) / 13;
      second.Q.value = first.Q.value;
      lfo.frequency.value = 0.06 + parameter(values, 'rate', 22) / 72;
      firstDepth.gain.value = 120 + depth * 12;
      secondDepth.gain.value = 240 + depth * 16;
      lfo.connect(firstDepth).connect(first.frequency);
      lfo.connect(secondDepth).connect(second.frequency);
      lfo.start(0);
      scheduled.push(lfo);
      cursor.connect(first).connect(second);
      cursor = mixParallel(context, cursor, second, 54);
      return;
    }

    if (item.specId === 'soft-detune') {
      const sum = context.createGain();
      const wetBus = context.createGain();
      const cents = parameter(values, 'cents', 35);
      const spread = parameter(values, 'spread', 54) / 100;
      [-1, 1].forEach((direction) => {
        const delay = context.createDelay(0.05);
        const pan = context.createStereoPanner();
        const lfo = context.createOscillator();
        const modulation = context.createGain();
        delay.delayTime.value = 0.0085 + direction * 0.0008;
        pan.pan.value = direction * spread;
        lfo.frequency.value = 0.22 + direction * 0.035;
        modulation.gain.value = 0.0004 + cents / 28_000;
        lfo.connect(modulation).connect(delay.delayTime);
        lfo.start(0);
        scheduled.push(lfo);
        cursor.connect(delay).connect(pan).connect(wetBus);
      });
      cursor.connect(sum);
      const wetGain = context.createGain();
      wetGain.gain.value = parameter(values, 'blend', 28) / 100;
      wetBus.connect(wetGain).connect(sum);
      cursor = sum;
      return;
    }

    if (item.specId === 'tape-echo') {
      const delay = context.createDelay(1.2);
      const feedback = context.createGain();
      const damping = context.createBiquadFilter();
      delay.delayTime.value = mapDelaySeconds(parameter(values, 'time', 48));
      feedback.gain.value = Math.min(0.72, parameter(values, 'repeats', 34) / 139);
      damping.type = 'lowpass';
      damping.frequency.value = 3_400;
      delay.connect(damping).connect(feedback).connect(delay);
      cursor.connect(delay);
      cursor = mixParallel(context, cursor, delay, parameter(values, 'mix', 27));
      return;
    }

    if (item.specId === 'reverse-space' || item.specId === 'cloud-hall') {
      const convolver = context.createConvolver();
      const tone = context.createBiquadFilter();
      const decay = parameter(values, 'decay', item.specId === 'cloud-hall' ? 72 : 64);
      const seconds = item.specId === 'cloud-hall' ? 1.4 + decay / 14 : 1.1 + decay / 18;
      convolver.buffer = makeImpulse(context, seconds, item.specId === 'reverse-space', item.instanceId.length * 911);
      tone.type = 'lowpass';
      tone.frequency.value = item.specId === 'cloud-hall' ? 5_800 : 1_800 + parameter(values, 'tone', 46) * 52;
      cursor.connect(convolver).connect(tone);
      cursor = mixParallel(context, cursor, tone, parameter(values, 'mix', 40));
    }
  });

  return cursor;
}

function connectMaster(
  context: BaseAudioContext,
  input: AudioNode,
  outputValue: number,
) {
  const compressor = context.createDynamicsCompressor();
  const output = context.createGain();
  compressor.threshold.value = -8;
  compressor.knee.value = 6;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  output.gain.value = 0.04 + (clampParameter(outputValue) / 100) * 0.34;
  input.connect(compressor).connect(output);
  return output;
}

function stopScheduled(session: LiveAudioSession) {
  session.scheduled.forEach((node) => {
    try { node.stop(); } catch { /* already stopped */ }
    node.disconnect();
  });
  session.scheduled = [];
  if (session.source) {
    try { session.source.stop(); } catch { /* already stopped */ }
    session.source.disconnect();
    session.source = null;
  }
}

function startLiveGraph(
  session: LiveAudioSession,
  config: BoardAudioConfig,
  offsetSeconds: number,
) {
  stopScheduled(session);
  let buffer = session.buffers.get(config.source);
  if (!buffer) {
    buffer = makeAudioBuffer(session.context, config.source);
    session.buffers.set(config.source, buffer);
  }
  const source = session.context.createBufferSource();
  const input = session.context.createGain();
  source.buffer = buffer;
  source.loop = true;
  source.loopEnd = buffer.duration;
  source.connect(input);
  const effected = connectEffectChain(session.context, input, config, session.scheduled);
  const master = connectMaster(session.context, effected, config.output);
  master.connect(session.context.destination);
  const safeOffset = offsetSeconds % buffer.duration;
  source.start(0, safeOffset);
  session.source = source;
  session.startedAt = session.context.currentTime - safeOffset;
  session.duration = buffer.duration;
  session.sourceKind = config.source;
}

export async function createLiveSession(config: BoardAudioConfig) {
  const AudioContextClass = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持音频预览');
  const context = new AudioContextClass();
  await context.resume();
  const session: LiveAudioSession = {
    context,
    source: null,
    scheduled: [],
    buffers: new Map(),
    startedAt: 0,
    duration: SOURCE_DURATION_SECONDS,
    sourceKind: config.source,
  };
  startLiveGraph(session, config, 0);
  return session;
}

export function refreshLiveSession(session: LiveAudioSession, config: BoardAudioConfig) {
  const offset = config.source === session.sourceKind
    ? (session.context.currentTime - session.startedAt) % session.duration
    : 0;
  startLiveGraph(session, config, offset);
}

export async function disposeLiveSession(session: LiveAudioSession | null) {
  if (!session) return;
  stopScheduled(session);
  await session.context.close();
}

export async function renderBoardToWav(config: BoardAudioConfig) {
  const sampleRate = 44_100;
  const tail = estimateTailSeconds(config.chain, config.values, new Set(config.bypassed));
  const totalSeconds = SOURCE_DURATION_SECONDS + tail;
  const offline = new OfflineAudioContext(2, Math.ceil(totalSeconds * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  const input = offline.createGain();
  const scheduled: AudioScheduledSourceNode[] = [];
  source.buffer = makeAudioBuffer(offline, config.source);
  source.connect(input);
  const effected = connectEffectChain(offline, input, config, scheduled);
  connectMaster(offline, effected, config.output).connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index));
  return new Blob([encodePcm16Wav(channels, rendered.sampleRate)], { type: 'audio/wav' });
}
