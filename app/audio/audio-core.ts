import {
  getChordProgression,
  normalizeSourceConfig,
  type SourceConfig,
  type SourceKind,
} from './source-catalog.ts';
import { getEffectSpec, mapControlValue } from '../effects/catalog.ts';

export type { SourceConfig, SourceKind } from './source-catalog.ts';
export type SignalLane = 'A' | 'B';
export type RoutingMode = 'serial' | 'parallel';

export type RoutingConfig = {
  mode: RoutingMode;
  blend: number;
  spread: number;
};

export type SourceEvent = {
  time: number;
  duration: number;
  frequency: number;
  velocity: number;
  pan: number;
};

export type AudioChainItem = {
  instanceId: string;
  specId: string;
  lane?: SignalLane;
};

export type AudioValues = Record<string, Record<string, number>>;

export const SOURCE_DURATION_SECONDS = 6.4;
export const EXPORT_TAIL_BASE_SECONDS = 0.25;
export const EXPORT_DRY_TAIL_SECONDS = 0;
export const EXPORT_TAIL_SILENCE_THRESHOLD = 0.0001;
export const EXPORT_TAIL_KEEP_SECONDS = 0.15;
/** Keeps a single export below roughly 5 MiB of stereo PCM tail at 44.1 kHz. */
export const EXPORT_TAIL_SAFETY_CAP_SECONDS = 30;

export type TailEstimateOptions = {
  mode?: 'dry' | 'wet';
  routing?: RoutingConfig;
};

export type TailEstimatePolicy = {
  seconds: number;
  uncappedSeconds: number;
  capSeconds: number;
  capped: boolean;
  policy: 'complete' | 'safety-cap';
};

export function clampParameter(value: number) {
  return Math.min(100, Math.max(0, value));
}

export function mapDelaySeconds(value: number) {
  return Number((0.08 + clampParameter(value) * 0.0072).toFixed(4));
}

export function makeDriveCurve(value: number, length = 2048) {
  const safeLength = Math.max(3, Math.floor(length));
  const drive = 1.5 + clampParameter(value) * 0.12;
  const normalizer = Math.tanh(drive);
  const curve = new Float32Array(safeLength);

  for (let index = 0; index < safeLength; index += 1) {
    const input = (index / (safeLength - 1)) * 2 - 1;
    curve[index] = Math.tanh(input * drive) / normalizer;
  }

  return curve;
}

export function makeGateCurve(value: number, length = 2048) {
  const safeLength = Math.max(3, Math.floor(length));
  const threshold = 0.015 + (clampParameter(value) / 100) * 0.28;
  const curve = new Float32Array(safeLength);

  for (let index = 0; index < safeLength; index += 1) {
    const input = (index / (safeLength - 1)) * 2 - 1;
    const magnitude = Math.abs(input);
    if (magnitude <= threshold) {
      curve[index] = 0;
      continue;
    }
    curve[index] = Math.sign(input) * ((magnitude - threshold) / (1 - threshold));
  }

  return curve;
}

export function makeNoiseGateCurve(thresholdDb: number, length = 65_537) {
  const safeLength = Math.max(3, Math.floor(length));
  const threshold = 10 ** (Math.min(0, Math.max(-96, thresholdDb)) / 20);
  const kneeEnd = Math.min(1, threshold * 2);
  const closedGain = 0.04;
  const curve = new Float32Array(safeLength);

  for (let index = 0; index < safeLength; index += 1) {
    const input = (index / (safeLength - 1)) * 2 - 1;
    const magnitude = Math.abs(input);
    const knee = kneeEnd === threshold
      ? Number(magnitude >= threshold)
      : Math.min(1, Math.max(0, (magnitude - threshold) / (kneeEnd - threshold)));
    const gain = closedGain + (1 - closedGain) * knee * knee * (3 - 2 * knee);
    curve[index] = input * gain;
  }

  return curve;
}

type StrumStep = {
  offset: number;
  duration: number;
  velocity: number;
  direction: 'down' | 'up';
};

const STRUM_PATTERNS: Partial<Record<SourceKind, StrumStep[]>> = {
  chords: [
    { offset: 0, duration: 1.36, velocity: 0.76, direction: 'down' },
  ],
  'eighth-strum': [
    { offset: 0, duration: 1.68, velocity: 0.78, direction: 'down' },
    { offset: 0.36, duration: 1.34, velocity: 0.56, direction: 'up' },
    { offset: 0.72, duration: 1.02, velocity: 0.68, direction: 'down' },
    { offset: 1.08, duration: 0.68, velocity: 0.54, direction: 'up' },
  ],
  'syncopated-strum': [
    { offset: 0, duration: 1.68, velocity: 0.78, direction: 'down' },
    { offset: 0.27, duration: 1.43, velocity: 0.52, direction: 'up' },
    { offset: 0.72, duration: 1.02, velocity: 0.72, direction: 'down' },
    { offset: 0.9, duration: 0.86, velocity: 0.56, direction: 'up' },
    { offset: 1.26, duration: 0.52, velocity: 0.62, direction: 'down' },
  ],
  'wall-strum': [
    { offset: 0, duration: 1.75, velocity: 0.8, direction: 'down' },
    { offset: 0.76, duration: 0.98, velocity: 0.64, direction: 'down' },
  ],
};

function makeStrumEvents(chordFrequencies: number[][], pattern: StrumStep[]) {
  return chordFrequencies.flatMap((chord, chordIndex) => pattern.flatMap((step) => {
    const notes = step.direction === 'up' ? [...chord].reverse() : chord;
    return notes.map((frequency, noteIndex) => {
      const stringIndex = step.direction === 'up' ? chord.length - 1 - noteIndex : noteIndex;
      return {
        time: chordIndex * 1.45 + step.offset + noteIndex * 0.014,
        duration: step.duration,
        frequency,
        velocity: Math.max(0.32, step.velocity - noteIndex * 0.045),
        pan: (stringIndex - (chord.length - 1) / 2) * 0.13,
      };
    });
  }));
}

export function getSourceEvents(source: SourceKind | SourceConfig): SourceEvent[] {
  const config = normalizeSourceConfig(source);
  const chordFrequencies = getChordProgression(config.progression).frequencies;
  const strumPattern = STRUM_PATTERNS[config.performance];
  if (strumPattern) return makeStrumEvents(chordFrequencies, strumPattern);

  if (config.performance === 'arpeggio') {
    const notes = chordFrequencies.flatMap((chord) => [...chord, chord[1] * 2]);
    return notes.map((frequency, index) => ({
      time: index * 0.29,
      duration: 0.76,
      frequency,
      velocity: 0.62 + (index % 4 === 0 ? 0.12 : 0),
      pan: index % 2 === 0 ? -0.14 : 0.14,
    }));
  }

  const roots = chordFrequencies.map((chord) => chord[0] * 2);
  const notes = [roots[0], roots[0] * 1.12246, roots[0] * 1.18921, roots[1] * 2, roots[1] * 1.68179, roots[2] * 2, roots[2] * 1.49831, roots[2] * 1.33484, roots[3] * 1.49831, roots[3] * 1.68179, roots[3] * 2, roots[0] * 2];
  return notes.map((frequency, index) => ({
    time: index * 0.46,
    duration: index % 4 === 3 ? 0.82 : 0.42,
    frequency,
    velocity: index % 4 === 0 ? 0.78 : 0.64,
    pan: 0,
  }));
}

function seededNoise(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

const guitarProfiles = {
  'single-neck': { second: 0.3, third: 0.12, fourth: 0.05, pick: 0.14, decay: 2.85, gain: 0.35 },
  'single-bridge': { second: 0.5, third: 0.25, fourth: 0.12, pick: 0.23, decay: 3.15, gain: 0.31 },
  humbucker: { second: 0.42, third: 0.2, fourth: 0.06, pick: 0.11, decay: 2.55, gain: 0.38 },
  hollowbody: { second: 0.21, third: 0.07, fourth: 0.02, pick: 0.08, decay: 2.35, gain: 0.39 },
};

export function synthesizeSourceChannels(source: SourceKind | SourceConfig, sampleRate: number) {
  const config = normalizeSourceConfig(source);
  const profile = guitarProfiles[config.guitar];
  const frameCount = Math.ceil(SOURCE_DURATION_SECONDS * sampleRate);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const random = seededNoise(0x5f3759df + config.guitar.length * 97 + config.progression.length * 41);

  getSourceEvents(config).forEach((event, eventIndex) => {
    const startFrame = Math.floor(event.time * sampleRate);
    const eventFrames = Math.ceil(event.duration * sampleRate);
    const leftGain = Math.sqrt((1 - event.pan) * 0.5);
    const rightGain = Math.sqrt((1 + event.pan) * 0.5);
    const phaseOffset = eventIndex * 0.41;

    for (let frame = 0; frame < eventFrames && startFrame + frame < frameCount; frame += 1) {
      const time = frame / sampleRate;
      const attack = Math.min(1, time / 0.012);
      const decay = Math.exp(-profile.decay * time);
      const pick = time < 0.026 ? random() * (1 - time / 0.026) * profile.pick : 0;
      const vibrato = 1 + Math.sin(Math.PI * 2 * 4.6 * time + eventIndex) * Math.min(0.0016, time * 0.0008);
      const fundamental = Math.sin(Math.PI * 2 * event.frequency * vibrato * time + phaseOffset);
      const second = Math.sin(Math.PI * 2 * event.frequency * 2.006 * time + phaseOffset * 0.6) * profile.second;
      const third = Math.sin(Math.PI * 2 * event.frequency * 3.014 * time) * profile.third;
      const fourth = Math.sin(Math.PI * 2 * event.frequency * 4.028 * time + phaseOffset * 0.2) * profile.fourth;
      const sample = (fundamental + second + third + fourth + pick) * attack * decay * event.velocity * profile.gain;
      left[startFrame + frame] += sample * leftGain;
      right[startFrame + frame] += sample * rightGain;
    }
  });

  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] = Math.max(-1, Math.min(1, left[frame]));
    right[frame] = Math.max(-1, Math.min(1, right[frame]));
  }

  return [left, right];
}

const TAIL_EFFECT_IDS = new Set([
  'analog-delay', 'dm2-delay', 'tape-echo', 'digital-delay',
  'reverse-space', 'gated-room', 'cloud-hall',
]);

function effectKnobValue(specId: string, pedalValues: Record<string, number>, controlId: string) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === controlId);
  return clampParameter(pedalValues[controlId] ?? control?.defaultValue ?? 0);
}

function effectPhysicalValue(specId: string, pedalValues: Record<string, number>, controlId: string) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === controlId);
  if (!control) return 0;
  return mapControlValue(control, effectKnobValue(specId, pedalValues, controlId));
}

function delayRepeatsUntilQuiet(feedback: number) {
  if (feedback <= 0.01) return 1;
  return Math.max(1, Math.log(0.01) / Math.log(feedback));
}

function effectTailSeconds(specId: string, pedalValues: Record<string, number>) {
  if (!TAIL_EFFECT_IDS.has(specId) || effectKnobValue(specId, pedalValues, 'mix') === 0) return 0;

  if (specId === 'analog-delay' || specId === 'dm2-delay' || specId === 'tape-echo' || specId === 'digital-delay') {
    const delay = effectPhysicalValue(specId, pedalValues, 'time') / 1000;
    const feedbackControl = specId === 'tape-echo' || specId === 'dm2-delay' ? 'repeats' : 'feedback';
    const feedbackKnob = effectKnobValue(specId, pedalValues, feedbackControl);
    const feedback = specId === 'digital-delay'
      ? Math.min(0.84, feedbackKnob / 110)
      : Math.min(0.78, feedbackKnob / 112);
    const longestDelay = specId === 'digital-delay' ? delay * 1.013 : delay;
    return longestDelay * delayRepeatsUntilQuiet(feedback);
  }

  if (specId === 'reverse-space') {
    const impulse = Math.min(10, effectPhysicalValue(specId, pedalValues, 'decay'));
    const preDelay = Math.min(1, effectPhysicalValue(specId, pedalValues, 'preDelay') / 1000);
    return preDelay + impulse;
  }

  if (specId === 'cloud-hall') {
    const impulse = Math.min(10, effectPhysicalValue(specId, pedalValues, 'decay'));
    const preDelay = Math.min(1, effectPhysicalValue(specId, pedalValues, 'preDelay') / 1000);
    return preDelay + impulse;
  }

  if (specId === 'gated-room') {
    const decay = effectPhysicalValue(specId, pedalValues, 'decay');
    const hold = effectPhysicalValue(specId, pedalValues, 'hold') / 1000;
    const release = effectPhysicalValue(specId, pedalValues, 'release') / 1000;
    return 0.008 + Math.min(8, decay + hold + release);
  }

  return 0;
}

function routeTailSeconds(
  chain: AudioChainItem[],
  values: AudioValues,
  bypassed: Set<string>,
  routing: RoutingConfig,
) {
  const sumTail = (items: AudioChainItem[]) => items.reduce((total, item) => {
    if (bypassed.has(item.instanceId)) return total;
    return total + effectTailSeconds(item.specId, values[item.instanceId] ?? {});
  }, 0);

  if (routing.mode === 'serial') return sumTail(chain);
  const blend = clampParameter(routing.blend);
  const laneA = blend >= 100 ? 0 : sumTail(chain.filter((item) => (item.lane ?? 'A') === 'A'));
  const laneB = blend <= 0 ? 0 : sumTail(chain.filter((item) => item.lane === 'B'));
  return Math.max(laneA, laneB);
}

function tidyTailSeconds(value: number) {
  return Number(value.toFixed(2));
}

/** Reports both practical support and the explicit bounded-export policy. */
export function estimateTailPolicy(
  chain: AudioChainItem[],
  values: AudioValues,
  bypassed: Set<string>,
  options: TailEstimateOptions = {},
): TailEstimatePolicy {
  if (options.mode === 'dry') {
    return {
      seconds: EXPORT_DRY_TAIL_SECONDS,
      uncappedSeconds: EXPORT_DRY_TAIL_SECONDS,
      capSeconds: EXPORT_TAIL_SAFETY_CAP_SECONDS,
      capped: false,
      policy: 'complete',
    };
  }

  const routing = options.routing ?? { mode: 'serial', blend: 50, spread: 0 };
  const uncapped = Math.max(
    EXPORT_TAIL_BASE_SECONDS,
    routeTailSeconds(chain, values, bypassed, routing),
  );
  const capped = uncapped > EXPORT_TAIL_SAFETY_CAP_SECONDS;
  return {
    seconds: tidyTailSeconds(Math.min(uncapped, EXPORT_TAIL_SAFETY_CAP_SECONDS)),
    uncappedSeconds: tidyTailSeconds(uncapped),
    capSeconds: EXPORT_TAIL_SAFETY_CAP_SECONDS,
    capped,
    policy: capped ? 'safety-cap' : 'complete',
  };
}

export function estimateTailSeconds(
  chain: AudioChainItem[],
  values: AudioValues,
  bypassed: Set<string>,
  options: TailEstimateOptions = {},
) {
  return estimateTailPolicy(chain, values, bypassed, options).seconds;
}

export type TailTrimOptions = {
  threshold?: number;
  keepSeconds?: number;
};

/** Removes inaudible padding after a rendered wet tail while keeping a short fade-out window. */
export function trimRenderedTail(
  channels: Float32Array[],
  sampleRate: number,
  options: TailTrimOptions = {},
) {
  if (channels.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return channels;
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  if (frameCount <= 0) return channels;
  const threshold = Math.max(0, options.threshold ?? EXPORT_TAIL_SILENCE_THRESHOLD);
  const keepFrames = Math.max(0, Math.ceil((options.keepSeconds ?? EXPORT_TAIL_KEEP_SECONDS) * sampleRate));
  let lastActiveFrame = frameCount - 1;
  while (lastActiveFrame >= 0) {
    const active = channels.some((channel) => Math.abs(channel[lastActiveFrame]) >= threshold);
    if (active) break;
    lastActiveFrame -= 1;
  }
  if (lastActiveFrame < 0) return channels;
  const outputFrameCount = Math.min(frameCount, lastActiveFrame + 1 + keepFrames);
  if (outputFrameCount >= frameCount) return channels;
  return channels.map((channel) => channel.slice(0, outputFrameCount));
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodePcm16Wav(channels: Float32Array[], sampleRate: number) {
  if (channels.length === 0) throw new Error('At least one channel is required');
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  const channelCount = channels.length;
  const bytesPerSample = 2;
  const dataLength = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.min(1, Math.max(-1, channels[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}
