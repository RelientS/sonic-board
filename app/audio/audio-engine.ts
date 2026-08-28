import {
  clampParameter,
  encodePcm16Wav,
  estimateTailSeconds,
  makeDriveCurve,
  makeGateCurve,
  makeNoiseGateCurve,
  SOURCE_DURATION_SECONDS,
  synthesizeSourceChannels,
  trimRenderedTail,
  type AudioChainItem,
  type AudioValues,
  type RoutingConfig,
  type SourceConfig,
} from './audio-core.ts';
import { sourceConfigKey } from './source-catalog.ts';
import { renderSampledSourceBuffer } from './sample-renderer.ts';
import { applySampleInputHeadroom } from './sample-library.ts';
import { getEffectSpec, mapControlValue } from '../effects/catalog.ts';
import { EFFECT_FIDELITY_PROFILES, type EffectFidelityProfile } from '../effects/fidelity.ts';
import { AMP_SPECS, CAB_SPECS, getAmpSpec, getCabSpec, type AmpCabConfig } from '../amps/catalog.ts';
import { computeLaneMix, partitionChain } from './routing.ts';

export const SUPPORTED_EFFECT_IDS = new Set([
  'studio-comp', 'noise-gate', 'graphic-eq',
  'blue-drive', 'rodent-dist', 'wall-fuzz', 'chainsaw-dist',
  'fuzz-face', 'ocd-drive', 'klon-centaur', 'sd1-drive', 'tube-screamer',
  'slow-phase', 'phase90', 'analog-chorus', 'jet-flanger', 'tape-vibrato', 'bias-tremolo', 'soft-detune',
  'analog-delay', 'dm2-delay', 'tape-echo', 'digital-delay',
  'reverse-space', 'gated-room', 'cloud-hall',
]);
export const SUPPORTED_AMP_IDS = new Set(AMP_SPECS.map((amp) => amp.id));
export const SUPPORTED_CAB_IDS = new Set(CAB_SPECS.map((cab) => cab.id));
export const PEDALKERNEL_EFFECT_IDS: ReadonlySet<string> = new Set([
  'studio-comp', 'blue-drive', 'rodent-dist', 'wall-fuzz', 'dm2-delay',
  'analog-delay', 'fuzz-face', 'analog-chorus', 'ocd-drive', 'klon-centaur',
  'sd1-drive', 'tube-screamer', 'phase90',
]);
export const PEDALKERNEL_FALLBACK_EFFECT_IDS: ReadonlySet<string> = new Set(PEDALKERNEL_EFFECT_IDS);
export { EFFECT_FIDELITY_PROFILES, type EffectFidelityProfile };

const MAX_CURVE_CACHE_ENTRIES = 32;
const MAX_IMPULSE_CACHE_ENTRIES = 8;
const MAX_CABINET_CACHE_ENTRIES = 4;
const MAX_SOURCE_BUFFER_ENTRIES = 4;
const driveCurveCache = new Map<string, Float32Array<ArrayBuffer>>();
const gateCurveCache = new Map<string, Float32Array<ArrayBuffer>>();
const noiseGateCurveCache = new Map<string, Float32Array<ArrayBuffer>>();
const impulseCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const cabinetImpulseCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const noiseGateReady = new WeakSet<BaseAudioContext>();
const noiseGateLoading = new WeakMap<BaseAudioContext, Promise<void>>();
const pedalKernelReady = new WeakSet<BaseAudioContext>();
const pedalKernelLoading = new WeakMap<BaseAudioContext, Promise<void>>();
const pedalKernelModules = new WeakMap<BaseAudioContext, WebAssembly.Module>();
let pedalKernelModulePromise: Promise<WebAssembly.Module> | null = null;
const PEDALKERNEL_RUNTIME_VERSION = 4;

const PEDALKERNEL_MODELS: Record<string, { modelId: number; controls: string[] }> = {
  'studio-comp': { modelId: 0, controls: ['sustain', 'level'] },
  'blue-drive': { modelId: 1, controls: ['gain', 'tone', 'level'] },
  'rodent-dist': { modelId: 2, controls: ['distortion', 'filter', 'volume'] },
  'wall-fuzz': { modelId: 3, controls: ['sustain', 'tone', 'volume'] },
  'dm2-delay': { modelId: 4, controls: ['time', 'repeats', 'mix'] },
  'analog-delay': { modelId: 5, controls: ['time', 'feedback', 'mix'] },
  'fuzz-face': { modelId: 6, controls: ['fuzz', 'volume'] },
  'analog-chorus': { modelId: 7, controls: ['rate', 'depth'] },
  'ocd-drive': { modelId: 8, controls: ['drive', 'tone', 'volume'] },
  'klon-centaur': { modelId: 9, controls: ['gain', 'treble', 'output'] },
  'sd1-drive': { modelId: 10, controls: ['drive', 'tone', 'level'] },
  'tube-screamer': { modelId: 11, controls: ['drive', 'tone', 'level'] },
  'phase90': { modelId: 12, controls: ['speed'] },
};

const LEGACY_DRIVE_MODELS: Record<string, {
  driveControl: string;
  driveDefault: number;
  outputControl: string;
  preGainBase: number;
  preGainScale: number;
  curveScale: number;
  highPassHz: number;
  lowPassHz: number;
  midHz: number;
  midGainDb: number;
  outputTrim: number;
  toneControl?: 'tone' | 'treble';
}> = {
  'fuzz-face': {
    driveControl: 'fuzz', driveDefault: 70, outputControl: 'volume',
    preGainBase: 1.8, preGainScale: 0.11, curveScale: 0.95,
    highPassHz: 45, lowPassHz: 7_000, midHz: 950, midGainDb: -1, outputTrim: 0.36,
  },
  'ocd-drive': {
    driveControl: 'drive', driveDefault: 50, outputControl: 'volume', toneControl: 'tone',
    preGainBase: 1.2, preGainScale: 0.08, curveScale: 0.78,
    highPassHz: 70, lowPassHz: 8_000, midHz: 900, midGainDb: 1.5, outputTrim: 0.5,
  },
  'klon-centaur': {
    driveControl: 'gain', driveDefault: 45, outputControl: 'output', toneControl: 'treble',
    preGainBase: 1, preGainScale: 0.055, curveScale: 0.52,
    highPassHz: 90, lowPassHz: 11_000, midHz: 1_000, midGainDb: 2, outputTrim: 0.62,
  },
  'sd1-drive': {
    driveControl: 'drive', driveDefault: 50, outputControl: 'level', toneControl: 'tone',
    preGainBase: 1.4, preGainScale: 0.07, curveScale: 0.65,
    highPassHz: 120, lowPassHz: 7_500, midHz: 720, midGainDb: 4, outputTrim: 0.48,
  },
  'tube-screamer': {
    driveControl: 'drive', driveDefault: 50, outputControl: 'level', toneControl: 'tone',
    preGainBase: 1.3, preGainScale: 0.065, curveScale: 0.62,
    highPassHz: 140, lowPassHz: 7_200, midHz: 720, midGainDb: 5, outputTrim: 0.48,
  },
};

export function activateMobileAudio(
  context: AudioContext,
  navigatorObject: Navigator = window.navigator,
) {
  try {
    const audioSession = (navigatorObject as Navigator & {
      audioSession?: { type: string };
    }).audioSession;
    if (audioSession) audioSession.type = 'playback';
  } catch {
    // Older WebKit versions expose no configurable audio session.
  }

  const unlockSource = context.createBufferSource();
  unlockSource.buffer = context.createBuffer(1, 1, context.sampleRate);
  unlockSource.connect(context.destination);
  unlockSource.start(0);
  void context.resume().catch(() => {
    // The awaited resume in createLiveSession reports a real activation failure.
  });
}

async function prepareNoiseGateProcessor(context: BaseAudioContext) {
  if (noiseGateReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = noiseGateLoading.get(context);
  if (!pending) {
    pending = worklet.addModule('/audio/noise-gate-processor.js').then(() => {
      noiseGateReady.add(context);
    }).catch(() => {
      // A calibrated soft gate below keeps preview and export usable on older browsers.
    });
    noiseGateLoading.set(context, pending);
  }
  await pending;
}

function loadPedalKernelModule() {
  if (pedalKernelModulePromise) return pedalKernelModulePromise;
  const pending = fetch(`/audio/pedalkernel.wasm?v=${PEDALKERNEL_RUNTIME_VERSION}`)
    .then((response) => {
      if (!response.ok) throw new Error(`PedalKernel WASM ${response.status}`);
      return response.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes));
  pedalKernelModulePromise = pending;
  void pending.catch(() => {
    if (pedalKernelModulePromise === pending) pedalKernelModulePromise = null;
  });
  return pending;
}

async function preparePedalKernelProcessor(context: BaseAudioContext) {
  if (pedalKernelReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = pedalKernelLoading.get(context);
  if (!pending) {
    pending = Promise.all([
      loadPedalKernelModule(),
      worklet.addModule(`/audio/pedalkernel-processor.js?v=${PEDALKERNEL_RUNTIME_VERSION}`),
    ]).then(([module]) => {
      pedalKernelModules.set(context, module);
      pedalKernelReady.add(context);
    }).catch(() => {
      pedalKernelLoading.delete(context);
      // The legacy Web Audio models below keep playback working on older browsers.
    });
    pedalKernelLoading.set(context, pending);
  }
  await pending;
}

export type BoardAudioConfig = {
  chain: AudioChainItem[];
  values: AudioValues;
  bypassed: string[];
  source: SourceConfig;
  mode: 'dry' | 'wet';
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
};

export type LiveAudioSession = {
  context: AudioContext;
  source: AudioBufferSourceNode | null;
  output: AudioNode | null;
  scheduled: AudioScheduledSourceNode[];
  buffers: Map<string, AudioBuffer>;
  bufferLoads: Map<string, Promise<AudioBuffer>>;
  startedAt: number;
  duration: number;
  sourceKey: string;
  revision: number;
};

function parameter(values: Record<string, number>, id: string, fallback: number) {
  return clampParameter(values[id] ?? fallback);
}

function physical(specId: string, values: Record<string, number>, id: string, fallback: number) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === id);
  if (!control) return fallback;
  return mapControlValue(control, parameter(values, id, control.defaultValue));
}

function dbToGain(db: number) {
  return 10 ** (db / 20);
}

function cachedValue<K, V>(cache: Map<K, V>, key: K, limit: number, create: () => V) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const value = create();
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

function cachedDriveCurve(value: number, length = 2048) {
  return cachedValue(
    driveCurveCache,
    `${clampParameter(value)}:${length}`,
    MAX_CURVE_CACHE_ENTRIES,
    () => makeDriveCurve(value, length),
  );
}

function cachedGateCurve(value: number, length = 2048) {
  return cachedValue(
    gateCurveCache,
    `${clampParameter(value)}:${length}`,
    MAX_CURVE_CACHE_ENTRIES,
    () => makeGateCurve(value, length),
  );
}

function cachedNoiseGateCurve(thresholdDb: number, length = 65_537) {
  return cachedValue(
    noiseGateCurveCache,
    `${thresholdDb}:${length}`,
    MAX_CURVE_CACHE_ENTRIES,
    () => makeNoiseGateCurve(thresholdDb, length),
  );
}

export function monitorMakeupGain(mode: 'dry' | 'wet') {
  return mode === 'wet' ? 2.8 : 1;
}

function isClosedAudioContext(context: BaseAudioContext) {
  return context.state === 'closed';
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

async function makeAudioBuffer(context: BaseAudioContext, source: SourceConfig) {
  try {
    return await renderSampledSourceBuffer(context, source);
  } catch {
    const channels = synthesizeSourceChannels(source, context.sampleRate);
    applySampleInputHeadroom(channels);
    const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
    channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
    return buffer;
  }
}

function cachedSessionBuffer(session: LiveAudioSession, key: string) {
  const buffer = session.buffers.get(key);
  if (!buffer) return undefined;
  session.buffers.delete(key);
  session.buffers.set(key, buffer);
  return buffer;
}

function rememberSessionBuffer(session: LiveAudioSession, key: string, buffer: AudioBuffer) {
  session.buffers.delete(key);
  session.buffers.set(key, buffer);
  while (session.buffers.size > MAX_SOURCE_BUFFER_ENTRIES) {
    const oldest = session.buffers.keys().next().value;
    if (oldest === undefined) break;
    session.buffers.delete(oldest);
  }
}

function loadSessionBuffer(session: LiveAudioSession, key: string, source: SourceConfig) {
  const cached = cachedSessionBuffer(session, key);
  if (cached) return Promise.resolve(cached);
  let pending = session.bufferLoads.get(key);
  if (!pending) {
    pending = makeAudioBuffer(session.context, source);
    session.bufferLoads.set(key, pending);
    void pending.then(
      () => { if (session.bufferLoads.get(key) === pending) session.bufferLoads.delete(key); },
      () => { if (session.bufferLoads.get(key) === pending) session.bufferLoads.delete(key); },
    );
  }
  return pending;
}

function makeImpulse(
  context: BaseAudioContext,
  seconds: number,
  kind: 'decay' | 'reverse' | 'gate',
  seed: number,
  density = 100,
) {
  let cache = impulseCaches.get(context);
  if (!cache) {
    cache = new Map();
    impulseCaches.set(context, cache);
  }
  const key = `${seconds}:${kind}:${seed}:${density}`;
  return cachedValue(cache, key, MAX_IMPULSE_CACHE_ENTRIES, () => {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(2, length, context.sampleRate);
    const random = seededRandom(seed);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        const phase = index / length;
        const envelope = kind === 'reverse'
          ? phase ** 2.2
          : kind === 'gate'
            ? phase < 0.58 ? (1 - phase * 0.72) : ((1 - phase) / 0.42) ** 2
            : (1 - phase) ** 2.5;
        const active = Math.abs(random()) <= density / 100;
        data[index] = active ? random() * envelope * 0.72 : 0;
      }
    }

    return buffer;
  });
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

function makePedalKernelNode(
  context: BaseAudioContext,
  specId: string,
  values: Record<string, number>,
) {
  const model = PEDALKERNEL_MODELS[specId];
  const wasmModule = pedalKernelModules.get(context);
  if (!model || !wasmModule || !pedalKernelReady.has(context) || typeof AudioWorkletNode === 'undefined') return null;
  try {
    return new AudioWorkletNode(context, 'sonic-pedalkernel', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule,
        expectedRuntimeVersion: PEDALKERNEL_RUNTIME_VERSION,
        modelId: model.modelId,
        controls: model.controls.map((id) => {
          const fallback = getEffectSpec(specId).controls.find((control) => control.id === id)?.defaultValue ?? 50;
          return parameter(values, id, fallback) / 100;
        }),
      },
    });
  } catch {
    return null;
  }
}

export function connectEffectChain(
  context: BaseAudioContext,
  input: AudioNode,
  config: BoardAudioConfig,
  scheduled: AudioScheduledSourceNode[],
  chain: AudioChainItem[] = config.chain,
) {
  const bypassed = new Set(config.bypassed);
  let cursor = input;

  chain.forEach((item) => {
    if (bypassed.has(item.instanceId)) return;
    const values = config.values[item.instanceId] ?? {};
    const specId = item.specId;
    const effectInput = cursor;

    if (PEDALKERNEL_EFFECT_IDS.has(specId)) {
      const processor = makePedalKernelNode(context, specId, values);
      if (processor) {
        cursor.connect(processor);
        cursor = processor;
        return;
      }
    }

    if (specId === 'studio-comp') {
      const compressor = context.createDynamicsCompressor();
      const toneFilter = context.createBiquadFilter();
      const output = context.createGain();
      const sustain = parameter(values, 'sustain', 46);
      compressor.threshold.value = -8 - sustain * 0.34;
      compressor.knee.value = 10;
      compressor.ratio.value = 2 + sustain / 9;
      compressor.attack.value = physical(specId, values, 'attack', 18) / 1000;
      compressor.release.value = 0.09 + sustain / 240;
      toneFilter.type = 'highshelf';
      toneFilter.frequency.value = 2_800;
      toneFilter.gain.value = (parameter(values, 'tone', 52) - 50) * 0.12;
      output.gain.value = dbToGain(physical(specId, values, 'level', 0));
      cursor.connect(compressor).connect(toneFilter).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'noise-gate') {
      const output = context.createGain();
      const thresholdDb = physical(specId, values, 'threshold', -55);
      const releaseMs = physical(specId, values, 'release', 180);
      output.gain.value = dbToGain(physical(specId, values, 'level', 0));
      let gate: AudioWorkletNode | null = null;
      if (noiseGateReady.has(context) && typeof AudioWorkletNode !== 'undefined') {
        try {
          gate = new AudioWorkletNode(context, 'sonic-noise-gate', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            parameterData: {
              thresholdDb,
              releaseMs,
            },
          });
        } catch {
          // The static curve is less expressive, but it keeps the chain usable.
        }
      }
      if (gate) {
        cursor.connect(gate).connect(output);
      } else {
        const fallbackGate = context.createWaveShaper();
        fallbackGate.curve = cachedNoiseGateCurve(thresholdDb);
        cursor.connect(fallbackGate).connect(output);
      }
      cursor = output;
      return;
    }

    if (specId === 'graphic-eq') {
      let eqCursor = cursor;
      ['100', '200', '400', '800', '1600', '3200', '6400'].forEach((band, index) => {
        const filter = context.createBiquadFilter();
        filter.type = index === 6 ? 'highshelf' : 'peaking';
        filter.frequency.value = Number(band);
        filter.Q.value = index === 6 ? 0.7 : 1.18;
        filter.gain.value = physical(specId, values, band, 0);
        eqCursor.connect(filter);
        eqCursor = filter;
      });
      const output = context.createGain();
      output.gain.value = dbToGain(physical(specId, values, 'level', 0));
      eqCursor.connect(output);
      cursor = output;
      return;
    }

    if (specId === 'blue-drive' || specId === 'rodent-dist') {
      const preGain = context.createGain();
      const shaper = context.createWaveShaper();
      const highPass = context.createBiquadFilter();
      const lowPass = context.createBiquadFilter();
      const output = context.createGain();
      const drive = parameter(values, specId === 'blue-drive' ? 'gain' : 'distortion', 45);
      preGain.gain.value = specId === 'blue-drive' ? 1 + drive / 20 : 1.8 + drive / 10;
      shaper.curve = cachedDriveCurve(specId === 'blue-drive' ? drive * 0.58 : drive * 1.08);
      shaper.oversample = '4x';
      highPass.type = 'highpass';
      highPass.frequency.value = specId === 'blue-drive' ? 72 : 48;
      lowPass.type = 'lowpass';
      lowPass.frequency.value = specId === 'rodent-dist'
        ? 11_500 - parameter(values, 'filter', 45) * 91
        : physical(specId, values, 'tone', 4_800);
      lowPass.Q.value = 0.68;
      output.gain.value = dbToGain(physical(specId, values, specId === 'blue-drive' ? 'level' : 'volume', -1)) * (specId === 'rodent-dist' ? 0.46 : 0.58);
      cursor.connect(preGain).connect(shaper).connect(highPass).connect(lowPass).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'wall-fuzz') {
      const dryInput = cursor;
      const preGain = context.createGain();
      const gate = context.createWaveShaper();
      const shaper = context.createWaveShaper();
      const toneFilter = context.createBiquadFilter();
      const mids = context.createBiquadFilter();
      const output = context.createGain();
      const sustain = parameter(values, 'sustain', 67);
      preGain.gain.value = 2.2 + sustain / 9;
      gate.curve = cachedGateCurve(parameter(values, 'gate', 8) * 0.65);
      shaper.curve = cachedDriveCurve(sustain * 1.15);
      shaper.oversample = '4x';
      toneFilter.type = 'lowpass';
      toneFilter.frequency.value = physical(specId, values, 'tone', 4_200);
      toneFilter.Q.value = 0.78;
      mids.type = 'peaking';
      mids.frequency.value = 1_050;
      mids.Q.value = 0.92;
      mids.gain.value = physical(specId, values, 'mids', 0);
      output.gain.value = dbToGain(physical(specId, values, 'volume', -1)) * 0.27;
      dryInput.connect(preGain).connect(gate).connect(shaper).connect(toneFilter).connect(mids).connect(output);
      if (parameter(values, 'attack', 22) > 1) {
        const attackFilter = context.createBiquadFilter();
        const attackGain = context.createGain();
        attackFilter.type = 'bandpass';
        attackFilter.frequency.value = 2_300;
        attackFilter.Q.value = 0.8;
        attackGain.gain.value = parameter(values, 'attack', 22) / 420;
        dryInput.connect(attackFilter).connect(attackGain).connect(output);
      }
      cursor = output;
      return;
    }

    const legacyDrive = LEGACY_DRIVE_MODELS[specId];
    if (legacyDrive) {
      const preGain = context.createGain();
      const shaper = context.createWaveShaper();
      const highPass = context.createBiquadFilter();
      const toneFilter = context.createBiquadFilter();
      const mids = context.createBiquadFilter();
      const output = context.createGain();
      const drive = parameter(values, legacyDrive.driveControl, legacyDrive.driveDefault);
      preGain.gain.value = legacyDrive.preGainBase + drive * legacyDrive.preGainScale;
      shaper.curve = cachedDriveCurve(drive * legacyDrive.curveScale);
      shaper.oversample = '4x';
      highPass.type = 'highpass';
      highPass.frequency.value = legacyDrive.highPassHz;
      if (legacyDrive.toneControl === 'tone') {
        toneFilter.type = 'lowpass';
        toneFilter.frequency.value = physical(specId, values, 'tone', legacyDrive.lowPassHz);
        toneFilter.Q.value = 0.68;
      } else if (legacyDrive.toneControl === 'treble') {
        toneFilter.type = 'highshelf';
        toneFilter.frequency.value = 1_800;
        toneFilter.gain.value = (parameter(values, 'treble', 50) - 50) * 0.16;
      } else {
        toneFilter.type = 'lowpass';
        toneFilter.frequency.value = legacyDrive.lowPassHz;
        toneFilter.Q.value = 0.68;
      }
      mids.type = 'peaking';
      mids.frequency.value = legacyDrive.midHz;
      mids.Q.value = 0.82;
      mids.gain.value = legacyDrive.midGainDb;
      output.gain.value = dbToGain(physical(specId, values, legacyDrive.outputControl, -1)) * legacyDrive.outputTrim;
      cursor.connect(preGain).connect(shaper).connect(highPass).connect(toneFilter).connect(mids).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'chainsaw-dist') {
      const preGain = context.createGain();
      const shaper = context.createWaveShaper();
      const low = context.createBiquadFilter();
      const highMid = context.createBiquadFilter();
      const presence = context.createBiquadFilter();
      const output = context.createGain();
      const distortion = parameter(values, 'distortion', 78);
      preGain.gain.value = 2.4 + distortion / 8;
      shaper.curve = cachedDriveCurve(distortion * 1.2);
      shaper.oversample = '4x';
      low.type = 'lowshelf'; low.frequency.value = 120; low.gain.value = (parameter(values, 'low', 72) - 50) * 0.24;
      highMid.type = 'peaking'; highMid.frequency.value = 1_050; highMid.Q.value = 0.82; highMid.gain.value = (parameter(values, 'high', 76) - 50) * 0.28;
      presence.type = 'peaking'; presence.frequency.value = 2_700; presence.Q.value = 1.25; presence.gain.value = (parameter(values, 'high', 76) - 50) * 0.18;
      output.gain.value = dbToGain(physical(specId, values, 'level', -1)) * 0.3;
      cursor.connect(preGain).connect(shaper).connect(low).connect(highMid).connect(presence).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'slow-phase') {
      const first = context.createBiquadFilter();
      const second = context.createBiquadFilter();
      const third = context.createBiquadFilter();
      const fourth = context.createBiquadFilter();
      const lfo = context.createOscillator();
      const depths = [context.createGain(), context.createGain(), context.createGain(), context.createGain()];
      const filters = [first, second, third, fourth];
      const depth = parameter(values, 'depth', 38);
      filters.forEach((filter, index) => {
        filter.type = 'allpass';
        filter.frequency.value = [330, 620, 1_100, 1_900][index];
        filter.Q.value = 0.6 + parameter(values, 'res', 18) / 11;
        depths[index].gain.value = 80 + depth * (8 + index * 2.6);
        lfo.connect(depths[index]).connect(filter.frequency);
      });
      lfo.frequency.value = physical(specId, values, 'rate', 0.25);
      lfo.start(0); scheduled.push(lfo);
      cursor.connect(first).connect(second).connect(third).connect(fourth);
      cursor = mixParallel(context, cursor, fourth, parameter(values, 'mix', 44));
      return;
    }

    if (specId === 'phase90') {
      const filters = [
        context.createBiquadFilter(),
        context.createBiquadFilter(),
        context.createBiquadFilter(),
        context.createBiquadFilter(),
      ];
      const lfo = context.createOscillator();
      const depths = [180, 300, 480, 720].map((depth) => {
        const modulation = context.createGain();
        modulation.gain.value = depth;
        lfo.connect(modulation);
        return modulation;
      });
      filters.forEach((filter, index) => {
        filter.type = 'allpass';
        filter.frequency.value = [360, 680, 1_150, 1_900][index];
        filter.Q.value = 1.15;
        depths[index].connect(filter.frequency);
      });
      lfo.frequency.value = physical(specId, values, 'speed', 0.25);
      lfo.start(0); scheduled.push(lfo);
      cursor.connect(filters[0]).connect(filters[1]).connect(filters[2]).connect(filters[3]);
      cursor = mixParallel(context, cursor, filters[3], 50);
      return;
    }

    if (specId === 'analog-chorus' || specId === 'soft-detune') {
      const wetBus = context.createGain();
      const toneFilter = context.createBiquadFilter();
      const spread = specId === 'soft-detune' ? parameter(values, 'spread', 54) / 100 : 0.72;
      [-1, 1].forEach((direction, index) => {
        const delay = context.createDelay(0.06);
        const pan = context.createStereoPanner();
        const lfo = context.createOscillator();
        const modulation = context.createGain();
        const depth = specId === 'soft-detune' ? physical(specId, values, 'cents', 7) / 30_000 : 0.0006 + parameter(values, 'depth', 48) / 18_000;
        delay.delayTime.value = specId === 'soft-detune' ? 0.009 + index * 0.0013 : 0.014 + index * 0.002;
        pan.pan.value = direction * spread;
        lfo.frequency.value = specId === 'soft-detune' ? 0.18 + index * 0.047 : physical(specId, values, 'rate', 0.6) * (1 + index * 0.05);
        modulation.gain.value = depth;
        lfo.connect(modulation).connect(delay.delayTime);
        lfo.start(0); scheduled.push(lfo);
        cursor.connect(delay).connect(pan).connect(wetBus);
      });
      toneFilter.type = 'lowpass';
      toneFilter.frequency.value = physical(specId, values, 'tone', 6_000);
      wetBus.connect(toneFilter);
      cursor = mixParallel(context, cursor, toneFilter, parameter(values, specId === 'soft-detune' ? 'blend' : 'mix', 38));
      return;
    }

    if (specId === 'jet-flanger') {
      const delay = context.createDelay(0.03);
      const feedback = context.createGain();
      const lfo = context.createOscillator();
      const modulation = context.createGain();
      const center = 0.001 + parameter(values, 'manual', 52) * 0.00007;
      delay.delayTime.value = center;
      feedback.gain.value = Math.min(0.84, parameter(values, 'res', 38) / 112);
      lfo.frequency.value = physical(specId, values, 'rate', 0.4);
      modulation.gain.value = Math.min(center * 0.82, 0.0004 + parameter(values, 'depth', 62) * 0.000065);
      lfo.connect(modulation).connect(delay.delayTime);
      lfo.start(0); scheduled.push(lfo);
      delay.connect(feedback).connect(delay);
      cursor.connect(delay);
      cursor = mixParallel(context, cursor, delay, parameter(values, 'mix', 46));
      return;
    }

    if (specId === 'tape-vibrato') {
      const delay = context.createDelay(0.05);
      const toneFilter = context.createBiquadFilter();
      const lfo = context.createOscillator();
      const modulation = context.createGain();
      const rise = physical(specId, values, 'rise', 200) / 1000;
      delay.delayTime.value = 0.012;
      lfo.frequency.value = physical(specId, values, 'rate', 0.35);
      modulation.gain.setValueAtTime(0, context.currentTime);
      modulation.gain.linearRampToValueAtTime(0.00025 + physical(specId, values, 'depth', 8) / 12_000, context.currentTime + Math.max(0.005, rise));
      lfo.connect(modulation).connect(delay.delayTime);
      lfo.start(0); scheduled.push(lfo);
      toneFilter.type = 'lowpass'; toneFilter.frequency.value = physical(specId, values, 'tone', 5_000);
      cursor.connect(delay).connect(toneFilter);
      cursor = toneFilter;
      return;
    }

    if (specId === 'bias-tremolo') {
      const tremolo = context.createGain();
      const lfo = context.createOscillator();
      const shape = context.createWaveShaper();
      const modulation = context.createGain();
      const depth = parameter(values, 'depth', 48) / 100;
      tremolo.gain.value = 1 - depth * 0.5;
      lfo.frequency.value = physical(specId, values, 'rate', 1.2);
      shape.curve = cachedDriveCurve(parameter(values, 'wave', 35) * 0.75, 1024);
      modulation.gain.value = depth * 0.5;
      lfo.connect(shape).connect(modulation).connect(tremolo.gain);
      lfo.start(0); scheduled.push(lfo);
      const output = context.createGain();
      output.gain.value = dbToGain(physical(specId, values, 'level', 0));
      cursor.connect(tremolo).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'analog-delay' || specId === 'dm2-delay' || specId === 'tape-echo') {
      const delay = context.createDelay(specId === 'dm2-delay' ? 0.34 : specId === 'analog-delay' ? 0.81 : 1.3);
      const feedback = context.createGain();
      const damping = context.createBiquadFilter();
      const feedbackControl = specId === 'analog-delay' ? 'feedback' : 'repeats';
      const feedbackDefault = specId === 'dm2-delay' ? 35 : specId === 'tape-echo' ? 34 : 32;
      const mixDefault = specId === 'dm2-delay' ? 40 : specId === 'tape-echo' ? 27 : 30;
      delay.delayTime.value = physical(specId, values, 'time', 380) / 1000;
      feedback.gain.value = Math.min(0.78, parameter(values, feedbackControl, feedbackDefault) / 112);
      damping.type = 'lowpass';
      damping.frequency.value = specId === 'dm2-delay' ? 2_200 : physical(specId, values, 'tone', 3_500);
      if (specId !== 'dm2-delay') {
        const lfo = context.createOscillator();
        const modulation = context.createGain();
        lfo.frequency.value = specId === 'tape-echo' ? 0.42 : 0.18;
        modulation.gain.value = parameter(values, specId === 'tape-echo' ? 'wow' : 'mod', 14) / 38_000;
        lfo.connect(modulation).connect(delay.delayTime);
        lfo.start(0); scheduled.push(lfo);
      }
      delay.connect(damping).connect(feedback).connect(delay);
      cursor.connect(delay);
      cursor = mixParallel(context, cursor, delay, parameter(values, 'mix', mixDefault));
      return;
    }

    if (specId === 'digital-delay') {
      const left = context.createDelay(2.1);
      const right = context.createDelay(2.1);
      const leftPan = context.createStereoPanner();
      const rightPan = context.createStereoPanner();
      const feedbackLeft = context.createGain();
      const feedbackRight = context.createGain();
      const toneFilter = context.createBiquadFilter();
      const wet = context.createGain();
      const delayTime = physical(specId, values, 'time', 480) / 1000;
      const feedbackValue = Math.min(0.84, parameter(values, 'feedback', 36) / 110);
      const width = parameter(values, 'width', 68) / 100;
      left.delayTime.value = delayTime;
      right.delayTime.value = Math.min(2, delayTime * 1.013);
      leftPan.pan.value = -width; rightPan.pan.value = width;
      feedbackLeft.gain.value = feedbackValue; feedbackRight.gain.value = feedbackValue;
      toneFilter.type = 'lowpass'; toneFilter.frequency.value = physical(specId, values, 'tone', 7_000);
      cursor.connect(left); cursor.connect(right);
      left.connect(leftPan).connect(wet); right.connect(rightPan).connect(wet);
      left.connect(feedbackLeft).connect(right);
      right.connect(feedbackRight).connect(left);
      wet.connect(toneFilter);
      cursor = mixParallel(context, cursor, toneFilter, parameter(values, 'mix', 34));
      return;
    }

    if (specId === 'reverse-space' || specId === 'gated-room' || specId === 'cloud-hall') {
      const preDelay = context.createDelay(1.05);
      const convolver = context.createConvolver();
      const highPass = context.createBiquadFilter();
      const lowPass = context.createBiquadFilter();
      const decaySeconds = Math.min(10, physical(specId, values, 'decay', specId === 'cloud-hall' ? 6 : 3));
      const preDelaySeconds = specId === 'gated-room' ? 0.008 : physical(specId, values, 'preDelay', 20) / 1000;
      const kind = specId === 'reverse-space' ? 'reverse' : specId === 'gated-room' ? 'gate' : 'decay';
      const density = specId === 'reverse-space' ? parameter(values, 'density', 74) : 100;
      const impulseSeconds = specId === 'gated-room'
        ? Math.min(8, decaySeconds + physical(specId, values, 'hold', 180) / 1000 + physical(specId, values, 'release', 120) / 1000)
        : decaySeconds;
      preDelay.delayTime.value = Math.min(1, preDelaySeconds);
      convolver.buffer = makeImpulse(context, impulseSeconds, kind, item.instanceId.length * 911, density);
      highPass.type = 'highpass';
      highPass.frequency.value = specId === 'reverse-space' ? physical(specId, values, 'lowCut', 90) : 45;
      lowPass.type = 'lowpass';
      lowPass.frequency.value = specId === 'reverse-space' || specId === 'gated-room'
        ? physical(specId, values, 'highCut', 6_000)
        : physical(specId, values, 'tone', 6_000);
      cursor.connect(preDelay).connect(convolver).connect(highPass).connect(lowPass);
      if (specId === 'cloud-hall' && parameter(values, 'motion', 31) > 0) {
        const lfo = context.createOscillator();
        const modulation = context.createGain();
        lfo.frequency.value = 0.11;
        modulation.gain.value = parameter(values, 'motion', 31) / 180_000;
        lfo.connect(modulation).connect(preDelay.delayTime);
        lfo.start(0); scheduled.push(lfo);
      }
      cursor = mixParallel(context, cursor, lowPass, parameter(values, 'mix', 40));
    }

    if (PEDALKERNEL_EFFECT_IDS.has(specId) && cursor === effectInput) {
      throw new Error(`PedalKernel fallback missing: ${specId}`);
    }
  });

  return cursor;
}

function makeCabinetImpulse(context: BaseAudioContext, seconds: number, distance: number, room: number, seed: number) {
  let cache = cabinetImpulseCaches.get(context);
  if (!cache) {
    cache = new Map();
    cabinetImpulseCaches.set(context, cache);
  }
  const key = `${seconds}:${distance}:${room}:${seed}`;
  return cachedValue(cache, key, MAX_CABINET_CACHE_ENTRIES, () => {
    const roomTail = room / 100 * 0.055;
    const length = Math.max(1, Math.ceil(context.sampleRate * (seconds + roomTail)));
    const buffer = context.createBuffer(2, length, context.sampleRate);
    const random = seededRandom(seed);
    const distanceDelay = Math.floor((0.0004 + distance / 100 * 0.0045) * context.sampleRate);

    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      data[Math.min(length - 1, distanceDelay + channel * 2)] = 0.92;
      for (let index = distanceDelay + 1; index < length; index += 1) {
        const phase = (index - distanceDelay) / Math.max(1, length - distanceDelay);
        const cabinetDecay = Math.exp(-phase * (7.5 - room / 24));
        const earlyReflection = index % Math.max(7, Math.floor(context.sampleRate * 0.0017)) === 0 ? 0.34 : 0.08;
        data[index] += random() * cabinetDecay * earlyReflection * (0.42 + room / 180);
      }
    }

    return buffer;
  });
}

function connectAmpCab(context: BaseAudioContext, input: AudioNode, ampConfig: AmpCabConfig) {
  if (ampConfig.bypassed) return input;
  const amp = getAmpSpec(ampConfig.ampId);
  const cab = getCabSpec(ampConfig.cabId);
  const ampValues = ampConfig.ampValues;
  const cabValues = ampConfig.cabValues;
  const inputGain = context.createGain();
  const bass = context.createBiquadFilter();
  const mids = context.createBiquadFilter();
  const treble = context.createBiquadFilter();
  const shaper = context.createWaveShaper();
  const presence = context.createBiquadFilter();
  const ampCut = context.createBiquadFilter();
  const master = context.createGain();
  const gainValue = parameter(ampValues, 'gain', 40);

  inputGain.gain.value = 0.34 + parameter(ampValues, 'input', 50) / 42;
  bass.type = 'lowshelf'; bass.frequency.value = amp.voicing.lowHz; bass.gain.value = (parameter(ampValues, 'bass', 50) - 50) * 0.22;
  mids.type = 'peaking'; mids.frequency.value = amp.voicing.midHz; mids.Q.value = 0.72; mids.gain.value = (parameter(ampValues, 'mid', 50) - 50) * 0.25;
  treble.type = 'highshelf'; treble.frequency.value = amp.voicing.highHz; treble.gain.value = (parameter(ampValues, 'treble', 50) - 50) * 0.2;
  shaper.curve = cachedDriveCurve(Math.max(1, gainValue * amp.voicing.drive));
  shaper.oversample = '4x';
  presence.type = 'peaking'; presence.frequency.value = amp.voicing.presenceHz; presence.Q.value = 0.72; presence.gain.value = (parameter(ampValues, 'presence', 50) - 50) * 0.17;
  ampCut.type = 'lowpass'; ampCut.frequency.value = amp.voicing.highCut; ampCut.Q.value = 0.62;
  master.gain.value = (0.12 + parameter(ampValues, 'master', 60) / 94) / (0.74 + gainValue / 115);
  input.connect(inputGain).connect(bass).connect(mids).connect(treble).connect(shaper).connect(presence).connect(ampCut).connect(master);

  const cabHighPass = context.createBiquadFilter();
  const cabLowPass = context.createBiquadFilter();
  const body = context.createBiquadFilter();
  const air = context.createBiquadFilter();
  const position = parameter(cabValues, 'position', 48);
  const distance = parameter(cabValues, 'distance', 18);
  const room = parameter(cabValues, 'room', 10);
  cabHighPass.type = 'highpass'; cabHighPass.frequency.value = cab.voicing.lowCut + distance * 0.32;
  cabLowPass.type = 'lowpass'; cabLowPass.frequency.value = Math.max(2_000, cab.voicing.highCut * (1.12 - position / 330 - distance / 520)); cabLowPass.Q.value = 0.72;
  body.type = 'peaking'; body.frequency.value = cab.voicing.bodyHz; body.Q.value = 0.95; body.gain.value = cab.voicing.bodyGain;
  air.type = 'peaking'; air.frequency.value = cab.voicing.airHz; air.Q.value = 1.08; air.gain.value = cab.voicing.airGain + (50 - position) * 0.045;
  master.connect(cabHighPass).connect(body).connect(air).connect(cabLowPass);

  if (cab.voicing.impulseSeconds <= 0) return cabLowPass;
  const convolver = context.createConvolver();
  convolver.normalize = true;
  convolver.buffer = makeCabinetImpulse(context, cab.voicing.impulseSeconds, distance, room, cab.id.length * 1877);
  cabLowPass.connect(convolver);
  return convolver;
}

function connectBoardGraph(
  context: BaseAudioContext,
  input: AudioNode,
  config: BoardAudioConfig,
  scheduled: AudioScheduledSourceNode[],
) {
  if (config.mode === 'dry') return input;
  const routes = partitionChain(config.chain, config.routing.mode);
  let effected: AudioNode;

  if (config.routing.mode === 'serial') {
    effected = connectEffectChain(context, input, config, scheduled, routes.serial);
  } else {
    const sum = context.createGain();
    const laneMix = computeLaneMix(config.routing.blend, config.routing.spread);
    (['A', 'B'] as const).forEach((lane) => {
      const laneInput = context.createGain();
      const laneGain = context.createGain();
      const lanePan = context.createStereoPanner();
      input.connect(laneInput);
      const laneOutput = connectEffectChain(context, laneInput, config, scheduled, routes[lane]);
      laneGain.gain.value = laneMix[lane].gain;
      lanePan.pan.value = laneMix[lane].pan;
      laneOutput.connect(laneGain).connect(lanePan).connect(sum);
    });
    effected = sum;
  }

  const modeled = connectAmpCab(context, effected, config.amp);
  const monitorMakeup = context.createGain();
  monitorMakeup.gain.value = monitorMakeupGain(config.mode);
  modeled.connect(monitorMakeup);
  return monitorMakeup;
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

export function stopLiveGraph(session: LiveAudioSession) {
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
  if (session.output) {
    session.output.disconnect();
    session.output = null;
  }
}

function startLiveGraph(
  session: LiveAudioSession,
  config: BoardAudioConfig,
  offsetSeconds: number,
  buffer: AudioBuffer,
) {
  const key = sourceConfigKey(config.source);
  const scheduled: AudioScheduledSourceNode[] = [];
  const source = session.context.createBufferSource();
  let master: AudioNode | null = null;
  const safeOffset = offsetSeconds % buffer.duration;
  try {
    const input = session.context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = buffer.duration;
    source.connect(input);
    const effected = connectBoardGraph(session.context, input, config, scheduled);
    master = connectMaster(session.context, effected, config.output);
    source.start(0, safeOffset);
    master.connect(session.context.destination);
  } catch (error) {
    scheduled.forEach((node) => {
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
    });
    try { source.stop(); } catch { /* not started or already stopped */ }
    source.disconnect();
    master?.disconnect();
    throw error;
  }

  stopLiveGraph(session);
  session.scheduled = scheduled;
  session.source = source;
  session.output = master;
  session.startedAt = session.context.currentTime - safeOffset;
  session.duration = buffer.duration;
  session.sourceKey = key;
}

export async function createLiveSession(config: BoardAudioConfig) {
  const AudioContextClass = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持音频预览');
  const context = new AudioContextClass();
  try {
    activateMobileAudio(context, window.navigator);
    await context.resume();
    await Promise.all([prepareNoiseGateProcessor(context), preparePedalKernelProcessor(context)]);
    const session: LiveAudioSession = {
      context,
      source: null,
      output: null,
      scheduled: [],
      buffers: new Map(),
      bufferLoads: new Map(),
      startedAt: 0,
      duration: SOURCE_DURATION_SECONDS,
      sourceKey: sourceConfigKey(config.source),
      revision: 0,
    };
    const buffer = await loadSessionBuffer(session, session.sourceKey, config.source);
    rememberSessionBuffer(session, session.sourceKey, buffer);
    startLiveGraph(session, config, 0, buffer);
    return session;
  } catch (error) {
    try { await context.close(); } catch { /* preserve the original creation failure */ }
    throw error;
  }
}

export async function refreshLiveSession(session: LiveAudioSession, config: BoardAudioConfig) {
  if (isClosedAudioContext(session.context)) return;
  const revision = ++session.revision;
  await Promise.all([prepareNoiseGateProcessor(session.context), preparePedalKernelProcessor(session.context)]);
  const key = sourceConfigKey(config.source);
  const offset = sourceConfigKey(config.source) === session.sourceKey
    ? (session.context.currentTime - session.startedAt) % session.duration
    : 0;
  const buffer = await loadSessionBuffer(session, key, config.source);
  if (session.revision !== revision || isClosedAudioContext(session.context)) return;
  rememberSessionBuffer(session, key, buffer);
  startLiveGraph(session, config, offset, buffer);
}

export async function disposeLiveSession(session: LiveAudioSession | null) {
  if (!session) return;
  session.revision += 1;
  stopLiveGraph(session);
  session.buffers.clear();
  session.bufferLoads.clear();
  await session.context.close();
}

export async function renderBoardToWav(config: BoardAudioConfig) {
  const sampleRate = 44_100;
  const tail = estimateTailSeconds(config.chain, config.values, new Set(config.bypassed), {
    mode: config.mode,
    routing: config.routing,
  });
  const totalSeconds = SOURCE_DURATION_SECONDS + tail;
  const offline = new OfflineAudioContext(2, Math.ceil(totalSeconds * sampleRate), sampleRate);
  await Promise.all([prepareNoiseGateProcessor(offline), preparePedalKernelProcessor(offline)]);
  const source = offline.createBufferSource();
  const input = offline.createGain();
  const scheduled: AudioScheduledSourceNode[] = [];
  source.buffer = await makeAudioBuffer(offline, config.source);
  source.connect(input);
  const effected = connectBoardGraph(offline, input, config, scheduled);
  connectMaster(offline, effected, config.output).connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index));
  const exportChannels = config.mode === 'wet'
    ? trimRenderedTail(channels, rendered.sampleRate)
    : channels;
  return new Blob([encodePcm16Wav(exportChannels, rendered.sampleRate)], { type: 'audio/wav' });
}
