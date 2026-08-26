import {
  getChordProgression,
  normalizeSourceConfig,
  type SourceConfig,
  type SourceKind,
} from './source-catalog.ts';

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

export const SOURCE_DURATION_SECONDS = 6.1;

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

export function getSourceEvents(source: SourceKind | SourceConfig): SourceEvent[] {
  const config = normalizeSourceConfig(source);
  const chordFrequencies = getChordProgression(config.progression).frequencies;
  if (config.performance === 'chords') {
    return chordFrequencies.flatMap((chord, chordIndex) =>
      chord.map((frequency, noteIndex) => ({
        time: chordIndex * 1.45 + noteIndex * 0.014,
        duration: 1.36,
        frequency,
        velocity: 0.76 - noteIndex * 0.07,
        pan: (noteIndex - (chord.length - 1) / 2) * 0.13,
      })),
    );
  }

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

export function estimateTailSeconds(
  chain: AudioChainItem[],
  values: AudioValues,
  bypassed: Set<string>,
) {
  let tail = 0.25;

  chain.forEach((item) => {
    if (bypassed.has(item.instanceId)) return;
    const pedalValues = values[item.instanceId] ?? {};

    if (item.specId === 'tape-echo' || item.specId === 'analog-delay' || item.specId === 'digital-delay') {
      const timeValue = clampParameter(pedalValues.time ?? 45) / 100;
      const ranges = item.specId === 'analog-delay' ? [0.04, 0.8] : item.specId === 'digital-delay' ? [0.04, 2] : [0.06, 1.2];
      const delay = ranges[0] * (ranges[1] / ranges[0]) ** timeValue;
      const feedbackValue = item.specId === 'tape-echo' ? pedalValues.repeats : pedalValues.feedback;
      const feedback = Math.min(item.specId === 'digital-delay' ? 0.86 : 0.78, clampParameter(feedbackValue ?? 30) / 112);
      const repeatsUntilQuiet = feedback > 0.01 ? Math.log(0.01) / Math.log(feedback) : 1;
      tail = Math.max(tail, Math.min(10, delay * repeatsUntilQuiet));
    }

    if (item.specId === 'reverse-space') {
      tail = Math.max(tail, 1.1 + clampParameter(pedalValues.decay ?? 55) / 18);
    }

    if (item.specId === 'cloud-hall') {
      const normalized = clampParameter(pedalValues.decay ?? 65) / 100;
      tail = Math.max(tail, Math.min(12, 0.5 * (20 / 0.5) ** normalized));
    }

    if (item.specId === 'gated-room') {
      const decay = 0.3 * (8 / 0.3) ** (clampParameter(pedalValues.decay ?? 42) / 100);
      const hold = 0.001 * (3000 / 1) ** (clampParameter(pedalValues.hold ?? 38) / 100);
      const release = 0.005 * (3000 / 5) ** (clampParameter(pedalValues.release ?? 24) / 100);
      tail = Math.max(tail, Math.min(12, decay + hold + release));
    }
  });

  return Number(tail.toFixed(2));
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
