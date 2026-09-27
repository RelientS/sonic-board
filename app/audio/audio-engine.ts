import {
  clampParameter,
  encodePcmWav,
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
import { AMP_SPECS, CAB_SPECS, getAmpSpec, getCabSpec, type AmpCabConfig, type CabSpec } from '../amps/catalog.ts';
import { minimumPhaseImpulse, speakerMagnitude, type SpeakerVoicing } from './dsp-math.ts';
import { computeLaneMix, partitionChain } from './routing.ts';
import type { NamModelRecord } from './nam-model.ts';

export const SUPPORTED_EFFECT_IDS = new Set([
  'studio-comp', 'noise-gate', 'graphic-eq',
  'blue-drive', 'rodent-dist', 'fuzz-war-nam', 'wall-fuzz', 'opamp-muff', 'ds1-dist', 'chainsaw-dist',
  'fuzz-face', 'ocd-drive', 'klon-centaur', 'sd1-drive', 'tube-screamer',
  'slow-phase', 'phase90', 'analog-chorus', 'jet-flanger', 'tape-vibrato', 'bias-tremolo', 'soft-detune',
  'analog-delay', 'dm2-delay', 'tape-echo', 'digital-delay',
  'reverse-space', 'gated-room', 'cloud-hall',
]);
export const SUPPORTED_AMP_IDS = new Set(AMP_SPECS.map((amp) => amp.id));
export const SUPPORTED_CAB_IDS = new Set(CAB_SPECS.map((cab) => cab.id));
export const PEDALKERNEL_EFFECT_IDS: ReadonlySet<string> = new Set([
  'studio-comp', 'blue-drive', 'rodent-dist', 'wall-fuzz',
  'fuzz-face', 'analog-chorus', 'ocd-drive', 'klon-centaur',
  'sd1-drive', 'tube-screamer', 'phase90',
]);
export const PEDALKERNEL_FALLBACK_EFFECT_IDS: ReadonlySet<string> = new Set(PEDALKERNEL_EFFECT_IDS);
export const NAM_EFFECT_IDS: ReadonlySet<string> = new Set(['fuzz-war-nam']);
// Pedals solved from their schematics by the DK circuit engine
// (dsp/circuit). Control ids are listed in the netlist's control order.
export const CIRCUIT_MODELS: Record<string, { model: string; controls: string[]; switches?: string[] }> = {
  'wall-fuzz': { model: 'rams-head-muff', controls: ['volume', 'tone', 'sustain'] },
  'opamp-muff': { model: 'opamp-big-muff', controls: ['volume', 'tone', 'sustain'], switches: ['tonebypass'] },
  'rodent-dist': { model: 'proco-rat2', controls: ['volume', 'filter', 'distortion'] },
  'ds1-dist': { model: 'boss-ds1', controls: ['level', 'tone', 'dist'] },
  'blue-drive': { model: 'boss-bd2', controls: ['level', 'tone', 'gain'] },
  'klon-centaur': { model: 'klon-centaur', controls: ['gain', 'treble', 'output'] },
  'fuzz-face': { model: 'fuzz-face', controls: ['volume', 'fuzz'] },
  'tube-screamer': { model: 'ibanez-ts808', controls: ['drive', 'tone', 'level'] },
  'sd1-drive': { model: 'boss-sd1', controls: ['drive', 'tone', 'level'] },
  'ocd-drive': { model: 'fulltone-ocd', controls: ['volume', 'tone', 'drive'], switches: ['hp'] },
  'phase90': { model: 'mxr-phase90', controls: ['speed'], switches: ['script'] },
  'studio-comp': { model: 'mxr-dynacomp', controls: ['level', 'sustain'] },
};
export const CIRCUIT_EFFECT_IDS: ReadonlySet<string> = new Set(Object.keys(CIRCUIT_MODELS));
// Also the circuit.wasm cache key: bump whenever the WASM or its models change.
const CIRCUIT_RUNTIME_VERSION = 5;
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
const namProcessorReady = new WeakSet<BaseAudioContext>();
const namProcessorLoading = new WeakMap<BaseAudioContext, Promise<void>>();
const namWasmModules = new WeakMap<BaseAudioContext, WebAssembly.Module>();
let namWasmModulePromise: Promise<WebAssembly.Module> | null = null;
let pedalKernelModulePromise: Promise<WebAssembly.Module> | null = null;
const PEDALKERNEL_RUNTIME_VERSION = 4;
// /audio/* is served with a one-year immutable cache, so every change to a
// worklet file must bump its query version (independent of the WASM ABI).
const WORKLET_VERSIONS = {
  noiseGate: 2,
  pedalKernel: 5,
  nam: 4,
  circuit: 3,
  fx: 2,
} as const;
const fxReady = new WeakSet<BaseAudioContext>();
const fxLoading = new WeakMap<BaseAudioContext, Promise<void>>();

/** Reverb, flanger and master limiter worklets (plain JS, loaded once). */
async function prepareFxProcessor(context: BaseAudioContext) {
  if (fxReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = fxLoading.get(context);
  if (!pending) {
    pending = worklet.addModule(`/audio/fx-processor.js?v=${WORKLET_VERSIONS.fx}`).then(() => {
      fxReady.add(context);
    }).catch(() => {
      // The Web Audio versions below keep working without the worklets.
    });
    fxLoading.set(context, pending);
  }
  await pending;
}

function makeFxNode(context: BaseAudioContext, name: 'sonic-reverb' | 'sonic-flanger' | 'sonic-limiter', params: Record<string, number>) {
  if (!fxReady.has(context) || typeof AudioWorkletNode === 'undefined') return null;
  try {
    return new AudioWorkletNode(context, name, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: params,
    });
  } catch {
    return null;
  }
}
const circuitReady = new WeakSet<BaseAudioContext>();
const circuitLoading = new WeakMap<BaseAudioContext, Promise<void>>();
type CircuitRuntime = { wasmModule: WebAssembly.Module; modelIndex: Map<string, number> };
const circuitRuntimes = new WeakMap<BaseAudioContext, CircuitRuntime>();
let circuitRuntimePromise: Promise<CircuitRuntime> | null = null;

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
    pending = worklet.addModule(`/audio/noise-gate-processor.js?v=${WORKLET_VERSIONS.noiseGate}`).then(() => {
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
      worklet.addModule(`/audio/pedalkernel-processor.js?v=${WORKLET_VERSIONS.pedalKernel}`),
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

export async function prepareNamProcessor(context: BaseAudioContext) {
  if (namProcessorReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = namProcessorLoading.get(context);
  if (!pending) {
    if (!namWasmModulePromise) {
      const modulePending = fetch('/audio/nam/nam.wasm?v=1')
        .then((response) => {
          if (!response.ok) throw new Error(`NAM WASM ${response.status}`);
          return response.arrayBuffer();
        })
        .then((bytes) => WebAssembly.compile(bytes));
      namWasmModulePromise = modulePending;
      void modulePending.catch(() => {
        if (namWasmModulePromise === modulePending) namWasmModulePromise = null;
      });
    }
    pending = Promise.all([
      namWasmModulePromise,
      worklet.addModule(`/audio/nam-processor.js?v=${WORKLET_VERSIONS.nam}`),
    ]).then(([wasmModule]) => {
      namWasmModules.set(context, wasmModule);
      namProcessorReady.add(context);
    }).catch((error) => {
      namProcessorLoading.delete(context);
      console.warn('[Sonic NAM] 无法准备浏览器运行时，将保持直通。', error);
      // A missing runtime is intentionally handled as an audible passthrough.
    });
    namProcessorLoading.set(context, pending);
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
  /** Private browser-owned NAM payloads keyed by EffectSpec.nam.slotId. */
  namModels?: Record<string, NamModelRecord>;
};

/** Whether a pedal is running its intended engine or silently degraded. */
export type EffectStatus = 'ok' | 'passthrough' | 'fallback';

/** One playable graph: source, effects and master, crossfaded as a unit. */
type LiveGraph = {
  config: BoardAudioConfig;
  structureKey: string;
  source: AudioBufferSourceNode;
  /** Gate between the source and the effects; closing it lets tails ring out. */
  input: GainNode;
  /** Master output level (the "output" control). */
  level: GainNode;
  /** Last master node (the limiter worklet when available). */
  masterOutput: AudioNode;
  /** Crossfade gate between this graph and the destination. */
  fade: GainNode;
  scheduled: AudioScheduledSourceNode[];
  slots: Map<string, EffectSlot>;
  namNodes: Map<string, AudioWorkletNode>;
};

export type LiveAudioSession = {
  context: AudioContext;
  graph: LiveGraph | null;
  /** Graphs fading out while their delay and reverb tails decay. */
  retiring: Set<LiveGraph>;
  buffers: Map<string, AudioBuffer>;
  bufferLoads: Map<string, Promise<AudioBuffer>>;
  startedAt: number;
  duration: number;
  sourceKey: string;
  revision: number;
  /** Structure being rebuilt asynchronously, and the newest config for it. */
  pendingStructure?: string;
  pendingConfig?: BoardAudioConfig;
  /** Loaded NAM nodes, reused across rebuilds (loading a model is slow). */
  namCache: Map<string, { modelJson: string; node: AudioWorkletNode }>;
  status: Map<string, EffectStatus>;
  onStatus?: (status: ReadonlyMap<string, EffectStatus>) => void;
  /** A live instrument input; while set it replaces the looping DI sample. */
  liveInput?: LiveInput;
  /** Removes the listeners that resume the context after an interruption. */
  detachResume?: () => void;
};

type LiveInput = { stream: MediaStream; source: MediaStreamAudioSourceNode; output: GainNode };

function disposeNamNode(node: AudioWorkletNode) {
  try { node.port.postMessage({ type: 'dispose' }); } catch { /* worklet already gone */ }
  try { node.disconnect(); } catch { /* node was never connected */ }
}

export function disposeNamNodes(nodes?: ReadonlyMap<string, AudioWorkletNode>) {
  if (!nodes) return;
  nodes.forEach(disposeNamNode);
}

async function createLoadedNamNode(context: BaseAudioContext, modelJson: string) {
  const wasmModule = namWasmModules.get(context);
  if (!wasmModule) return null;
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(context, 'sonic-nam', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { modelJson, wasmModule },
    });
  } catch (error) {
    console.warn('[Sonic NAM] 无法创建音频节点，将保持直通。', error);
    return null;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('NAM model load timeout')), 15_000);
      node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
        if (event.data?.type === 'model-loaded') {
          clearTimeout(timeout);
          resolve();
        } else if (event.data?.type === 'model-error') {
          clearTimeout(timeout);
          reject(new Error(event.data.message || 'NAM model load failed'));
        }
      };
      node.onprocessorerror = () => {
        clearTimeout(timeout);
        reject(new Error('NAM audio processor failed'));
      };
      node.port.start();
    });
    node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
      if (event.data?.type === 'process-error') {
        console.warn('[Sonic NAM] 实时处理失败，已自动直通。', event.data.message || 'unknown processor error');
      }
    };
    node.onprocessorerror = null;
    return node;
  } catch (error) {
    console.warn('[Sonic NAM] 模型加载失败，将保持直通。', error);
    disposeNamNode(node);
    return null;
  }
}

export async function prepareNamNodes(
  context: BaseAudioContext,
  config: BoardAudioConfig,
  cache?: Map<string, { modelJson: string; node: AudioWorkletNode }>,
) {
  const nodes = new Map<string, AudioWorkletNode>();
  if (config.mode === 'dry' || !config.namModels) return nodes;
  const bypassed = new Set(config.bypassed);
  const activeItems = config.chain.filter((item) => NAM_EFFECT_IDS.has(item.specId) && !bypassed.has(item.instanceId));
  if (activeItems.length === 0) return nodes;

  await prepareNamProcessor(context);
  if (!namProcessorReady.has(context)) return nodes;
  await Promise.all(activeItems.map(async (item) => {
    const slotId = getEffectSpec(item.specId).nam?.slotId;
    const modelJson = slotId ? config.namModels?.[slotId]?.modelJson : undefined;
    if (!modelJson) {
      console.warn(`[Sonic NAM] ${item.specId} 没有本机模型，将保持直通。`);
      return;
    }
    const cached = cache?.get(item.instanceId);
    if (cached && cached.modelJson === modelJson) {
      nodes.set(item.instanceId, cached.node);
      return;
    }
    const node = await createLoadedNamNode(context, modelJson);
    if (!node) return;
    nodes.set(item.instanceId, node);
    if (cache) {
      if (cached) disposeNamNode(cached.node);
      cache.set(item.instanceId, { modelJson, node });
    }
  }));
  return nodes;
}

function parameter(values: Record<string, number>, id: string, fallback: number) {
  return clampParameter(values[id] ?? fallback);
}

function physical(specId: string, values: Record<string, number>, id: string, fallback: number) {
  const control = getEffectSpec(specId).controls.find((entry) => entry.id === id);
  if (!control) return fallback;
  return mapControlValue(control, parameter(values, id, control.defaultValue));
}

/**
 * Phase 90 LFO rate for a speed-knob position: C7 15 uF charged through
 * R20 4k7 + R21 500k reverse-log between the Schmitt thresholds
 * (see dsp/circuit/models/mxr_phase90.cir), 0.13 Hz to 14 Hz.
 */
function phase90SpeedHz(knob: number) {
  const rotation = Math.min(1, Math.max(0, knob / 100));
  const resistance = 4_700 + 500_000 * (81 ** (1 - rotation) - 1) / 80;
  return 1 / (15e-6 * resistance * 1.008);
}

function legacyLinear(knob: number, min: number, max: number) {
  return min + (max - min) * knob / 100;
}

function legacyExponential(knob: number, min: number, max: number) {
  return min * (max / min) ** (knob / 100);
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
    const [left, right = left] = synthesizeSourceChannels(source, context.sampleRate);
    // Mono guitar signal into the pedals (see renderSampledSourceBuffer).
    const mono = left.map((sample, index) => (sample + right[index]) * 0.5);
    applySampleInputHeadroom([mono]);
    const buffer = context.createBuffer(1, mono.length, context.sampleRate);
    buffer.copyToChannel(mono, 0);
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
      let lowpassed = 0;
      for (let index = 0; index < length; index += 1) {
        const phase = index / length;
        const envelope = kind === 'reverse'
          ? phase ** 2.2
          : kind === 'gate'
            ? phase < 0.58 ? (1 - phase * 0.72) : ((1 - phase) / 0.42) ** 2
            : (1 - phase) ** 2.5;
        const active = Math.abs(random()) <= density / 100;
        const noise = active ? random() : 0;
        // Air absorbs highs faster than lows: the tail darkens as it decays.
        const time = kind === 'reverse' ? 1 - phase : phase;
        const coefficient = 0.92 - 0.8 * time;
        lowpassed += (noise - lowpassed) * coefficient;
        data[index] = lowpassed * envelope * (0.72 / Math.sqrt(coefficient));
      }
    }

    return buffer;
  });
}

function mixParallelNodes(
  context: BaseAudioContext,
  dryInput: AudioNode,
  wetInput: AudioNode,
  wetAmount: number,
) {
  const sum = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const mix = clampParameter(wetAmount) / 100;
  dry.gain.value = Math.cos(mix * Math.PI * 0.5);
  wet.gain.value = Math.sin(mix * Math.PI * 0.5);
  dryInput.connect(dry).connect(sum);
  wetInput.connect(wet).connect(sum);
  return { sum, dry, wet };
}

/** Equal-power dry/wet change without a click. */
function setMix(context: BaseAudioContext, mix: { dry: GainNode; wet: GainNode }, wetAmount: number) {
  const amount = clampParameter(wetAmount) / 100;
  const now = context.currentTime;
  mix.dry.gain.setTargetAtTime(Math.cos(amount * Math.PI * 0.5), now, 0.015);
  mix.wet.gain.setTargetAtTime(Math.sin(amount * Math.PI * 0.5), now, 0.015);
}

function mixParallel(
  context: BaseAudioContext,
  dryInput: AudioNode,
  wetInput: AudioNode,
  wetAmount: number,
) {
  return mixParallelNodes(context, dryInput, wetInput, wetAmount).sum;
}

async function loadCircuitRuntime(): Promise<CircuitRuntime> {
  const response = await fetch(`/audio/circuit.wasm?v=${CIRCUIT_RUNTIME_VERSION}`);
  if (!response.ok) throw new Error(`Circuit WASM ${response.status}`);
  const wasmModule = await WebAssembly.compile(await response.arrayBuffer());
  // Read the model table once on the main thread; the worklet only gets indices.
  const exports = new WebAssembly.Instance(wasmModule, {}).exports as unknown as {
    memory: WebAssembly.Memory;
    runtime_version: () => number;
    model_count: () => number;
    model_info: (model: number) => number;
    info_ptr: () => number;
  };
  if (exports.runtime_version() !== CIRCUIT_RUNTIME_VERSION) throw new Error('Circuit runtime version mismatch');
  const modelIndex = new Map<string, number>();
  for (let index = 0; index < exports.model_count(); index += 1) {
    const length = exports.model_info(index);
    const info = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.info_ptr(), length))) as { id: string };
    modelIndex.set(info.id, index);
  }
  return { wasmModule, modelIndex };
}

async function prepareCircuitProcessor(context: BaseAudioContext) {
  if (circuitReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = circuitLoading.get(context);
  if (!pending) {
    circuitRuntimePromise ??= loadCircuitRuntime();
    pending = Promise.all([
      circuitRuntimePromise,
      worklet.addModule(`/audio/circuit-processor.js?v=${WORKLET_VERSIONS.circuit}`),
    ]).then(([runtime]) => {
      circuitRuntimes.set(context, runtime);
      circuitReady.add(context);
    }).catch(() => {
      // PedalKernel and the Web Audio models keep playback working.
      circuitRuntimePromise = null;
    });
    circuitLoading.set(context, pending);
  }
  await pending;
}

function makeCircuitNode(
  context: BaseAudioContext,
  specId: string,
  values: Record<string, number>,
) {
  const circuit = CIRCUIT_MODELS[specId];
  const runtime = circuitRuntimes.get(context);
  const modelIndex = runtime?.modelIndex.get(circuit?.model ?? '');
  if (!circuit || !runtime || modelIndex === undefined || typeof AudioWorkletNode === 'undefined') return null;
  const spec = getEffectSpec(specId);
  const knob = (id: string) => parameter(values, id, spec.controls.find((control) => control.id === id)?.defaultValue ?? 50) / 100;
  try {
    return new AudioWorkletNode(context, 'sonic-circuit', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule: runtime.wasmModule,
        expectedRuntimeVersion: CIRCUIT_RUNTIME_VERSION,
        modelIndex,
        controls: circuit.controls.map(knob),
        switches: (circuit.switches ?? []).map((id) => (knob(id) >= 0.5 ? 1 : 0)),
      },
    });
  } catch {
    return null;
  }
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
  namNodes: ReadonlyMap<string, AudioWorkletNode> = new Map(),
  slots?: Map<string, EffectSlot>,
) {
  const bypassed = new Set(config.bypassed);
  let cursor = input;

  chain.forEach((item) => {
    if (bypassed.has(item.instanceId)) return;
    const values = config.values[item.instanceId] ?? {};
    if (slots) {
      const slot = createEffectSlot(context, cursor, item, values, namNodes);
      slots.set(item.instanceId, slot);
      cursor = slot.output;
    } else {
      const built = newEffectBuild(item.specId);
      cursor = buildEffect(context, cursor, item, values, built.scheduled, namNodes, built);
      scheduled.push(...built.scheduled);
    }
  });

  return cursor;
}

/** Nodes created for one effect instance, so they can be updated or retired. */
export type EffectBuild = {
  specId: string;
  engine: 'circuit' | 'pedalkernel' | 'nam' | 'web-audio' | 'passthrough';
  worklets: AudioWorkletNode[];
  scheduled: AudioScheduledSourceNode[];
  /** Applies new knob values in place; when set, knob changes skip a rebuild. */
  update?: (values: Record<string, number>) => void;
  /** Live-tweakable NAM gains: parameter changes skip a rebuild. */
  nam?: { node: AudioWorkletNode; input: GainNode; output: GainNode; dry: GainNode; wet: GainNode };
};

function newEffectBuild(specId: string): EffectBuild {
  return { specId, engine: 'web-audio', worklets: [], scheduled: [] };
}

/** Builds one effect from `effectInput` and returns its output node. */
function buildEffect(
  context: BaseAudioContext,
  effectInput: AudioNode,
  item: AudioChainItem,
  values: Record<string, number>,
  scheduled: AudioScheduledSourceNode[],
  namNodes: ReadonlyMap<string, AudioWorkletNode>,
  built: EffectBuild,
): AudioNode {
  const specId = item.specId;
  let cursor = effectInput;


  if (NAM_EFFECT_IDS.has(specId)) {
    const processor = namNodes.get(item.instanceId);
    if (processor) {
      const inputGain = context.createGain();
      const outputGain = context.createGain();
      inputGain.gain.value = dbToGain(physical(specId, values, 'input', 0));
      outputGain.gain.value = dbToGain(physical(specId, values, 'output', 0));
      effectInput.connect(inputGain).connect(processor).connect(outputGain);
      const mix = mixParallelNodes(context, effectInput, outputGain, parameter(values, 'mix', 100));
      built.engine = 'nam';
      built.nam = { node: processor, input: inputGain, output: outputGain, dry: mix.dry, wet: mix.wet };
      cursor = mix.sum;
    } else {
      built.engine = 'passthrough';
    }
    return cursor;
  }

  if (CIRCUIT_EFFECT_IDS.has(specId)) {
    const processor = makeCircuitNode(context, specId, values);
    if (processor) {
      built.worklets.push(processor);
      built.engine = 'circuit';
      cursor.connect(processor);
      cursor = processor;
      return cursor;
    }
  }

  if (PEDALKERNEL_EFFECT_IDS.has(specId)) {
    const processor = makePedalKernelNode(context, specId, values);
    if (processor) {
      built.worklets.push(processor);
      built.engine = 'pedalkernel';
      cursor.connect(processor);
      cursor = processor;
      return cursor;
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
    output.gain.value = dbToGain(legacyLinear(parameter(values, 'level', 85), -18, 12));
    cursor.connect(compressor).connect(toneFilter).connect(output);
    cursor = output;
    return cursor;
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
        built.worklets.push(gate);
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
    return cursor;
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
    return cursor;
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
      : legacyExponential(parameter(values, 'tone', 54), 800, 12_000);
    lowPass.Q.value = 0.68;
    const levelKnob = parameter(values, specId === 'blue-drive' ? 'level' : 'volume', 58);
    output.gain.value = dbToGain(legacyLinear(levelKnob, -18, 12)) * (specId === 'rodent-dist' ? 0.46 : 0.58);
    cursor.connect(preGain).connect(shaper).connect(highPass).connect(lowPass).connect(output);
    cursor = output;
    return cursor;
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
    // Circuit pedals expose knob positions; map them to the legacy
    // approximation's 800-12k Hz tone and -18..+12 dB volume ranges.
    toneFilter.frequency.value = legacyExponential(parameter(values, 'tone', 43), 800, 12_000);
    toneFilter.Q.value = 0.78;
    mids.type = 'peaking';
    mids.frequency.value = 1_050;
    mids.Q.value = 0.92;
    mids.gain.value = physical(specId, values, 'mids', 0);
    output.gain.value = dbToGain(legacyLinear(parameter(values, 'volume', 58), -18, 12)) * 0.27;
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
    return cursor;
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
    // The OCD's HP mode passes more low end than LP mode.
    highPass.frequency.value = specId === 'ocd-drive' && parameter(values, 'hp', 100) >= 50
      ? legacyDrive.highPassHz * 0.5
      : legacyDrive.highPassHz;
    if (legacyDrive.toneControl === 'tone') {
      toneFilter.type = 'lowpass';
      // Circuit pedals store knob positions: map them to the legacy ranges.
      toneFilter.frequency.value = legacyExponential(parameter(values, 'tone', 50), 800, 12_000);
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
    output.gain.value = dbToGain(legacyLinear(parameter(values, legacyDrive.outputControl, 62), -18, 12)) * legacyDrive.outputTrim;
    cursor.connect(preGain).connect(shaper).connect(highPass).connect(toneFilter).connect(mids).connect(output);
    cursor = output;
    return cursor;
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
    return cursor;
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
    return cursor;
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
    // Block-logo feedback (script switch off) sharpens the notches.
    const script = parameter(values, 'script', 100) >= 50;
    filters.forEach((filter, index) => {
      filter.type = 'allpass';
      filter.frequency.value = [360, 680, 1_150, 1_900][index];
      filter.Q.value = script ? 1.15 : 1.7;
      depths[index].connect(filter.frequency);
    });
    lfo.frequency.value = phase90SpeedHz(parameter(values, 'speed', 40));
    lfo.start(0); scheduled.push(lfo);
    cursor.connect(filters[0]).connect(filters[1]).connect(filters[2]).connect(filters[3]);
    cursor = mixParallel(context, cursor, filters[3], 50);
    return cursor;
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
    return cursor;
  }

  if (specId === 'jet-flanger') {
    const flangerParams = (v: Record<string, number>) => ({
      manual: parameter(v, 'manual', 52) / 100,
      rate: physical(specId, v, 'rate', 0.4),
      depth: parameter(v, 'depth', 62) / 100,
      feedback: (parameter(v, 'res', 38) / 100) * 0.92,
    });
    const flanger = makeFxNode(context, 'sonic-flanger', flangerParams(values));
    if (flanger) {
      built.worklets.push(flanger);
      cursor.connect(flanger);
      const mix = mixParallelNodes(context, cursor, flanger, parameter(values, 'mix', 46));
      built.update = (next) => {
        flanger.port.postMessage({ type: 'params', params: flangerParams(next) });
        setMix(context, mix, parameter(next, 'mix', 46));
      };
      return mix.sum;
    }
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
    return cursor;
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
    return cursor;
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
    return cursor;
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
    return cursor;
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
    return cursor;
  }

  if (specId === 'cloud-hall') {
    const reverbParams = (v: Record<string, number>) => ({
      decay: physical(specId, v, 'decay', 6),
      preDelay: physical(specId, v, 'preDelay', 20) / 1000,
      tone: physical(specId, v, 'tone', 6_000),
      motion: parameter(v, 'motion', 31) / 100,
      size: 1.5,
    });
    const reverb = makeFxNode(context, 'sonic-reverb', reverbParams(values));
    if (reverb) {
      built.worklets.push(reverb);
      const highPass = context.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 45;
      cursor.connect(reverb).connect(highPass);
      const mix = mixParallelNodes(context, cursor, highPass, parameter(values, 'mix', 40));
      built.update = (next) => {
        reverb.port.postMessage({ type: 'params', params: reverbParams(next) });
        setMix(context, mix, parameter(next, 'mix', 40));
      };
      return mix.sum;
    }
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
  // Nothing was built (e.g. a circuit-only pedal whose runtime failed).
  if (cursor === effectInput) built.engine = 'passthrough';
  return cursor;
}

/**
 * Cabinet impulse: a minimum-phase miked-speaker response designed from the
 * cab's voicing (resonance, body, presence, roll-off, cone-breakup ripple)
 * plus a few early room reflections, decorrelated left/right.
 */
function makeCabinetImpulse(context: BaseAudioContext, cab: CabSpec, position: number, distance: number, room: number) {
  let cache = cabinetImpulseCaches.get(context);
  if (!cache) {
    cache = new Map();
    cabinetImpulseCaches.set(context, cache);
  }
  const key = `${cab.id}:${Math.round(position)}:${Math.round(distance)}:${Math.round(room)}`;
  return cachedValue(cache, key, MAX_CABINET_CACHE_ENTRIES, () => {
    const sampleRate = context.sampleRate;
    const n = 4096;
    const closed = cab.format === 'CLOSED BACK';
    const voicing: SpeakerVoicing = {
      resonanceHz: cab.voicing.lowCut * (closed ? 1.3 : 1.2),
      resonanceQ: closed ? 1.3 : 0.85,
      openBackHz: closed ? 0 : cab.voicing.lowCut * 1.35,
      bodyHz: cab.voicing.bodyHz,
      bodyGain: cab.voicing.bodyGain,
      presenceHz: cab.voicing.airHz,
      presenceGain: cab.voicing.airGain,
      highCut: cab.voicing.highCut * 0.72,
      seed: [...cab.id].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261),
    };
    const speaker = minimumPhaseImpulse(speakerMagnitude(voicing, { position, distance }, sampleRate, n), n);
    const speakerLength = Math.min(n, Math.ceil(sampleRate * 0.045));
    // Distance adds propagation delay; the room adds a floor bounce and a few
    // wall reflections, slightly different per channel for width.
    const directDelay = Math.round(sampleRate * (0.0003 + distance / 100 * 0.0026));
    const roomAmount = room / 100;
    const reflections = [
      { seconds: 0.0021 + distance / 100 * 0.0018, gain: 0.32 + distance / 100 * 0.2 },
      { seconds: 0.0073, gain: 0.55 * roomAmount },
      { seconds: 0.0118, gain: 0.42 * roomAmount },
      { seconds: 0.0187, gain: 0.3 * roomAmount },
    ];
    const tailFrames = Math.ceil(sampleRate * (0.024 + roomAmount * 0.03));
    const length = directDelay + speakerLength + tailFrames;
    const buffer = context.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      const add = (offset: number, gain: number, darken: number) => {
        let state = 0;
        for (let i = 0; i < speakerLength && offset + i < length; i += 1) {
          // Reflections lose top end: a one-pole low-pass per bounce.
          state += (speaker[i] - state) * (1 - darken);
          const fade = i > speakerLength * 0.75 ? (speakerLength - i) / (speakerLength * 0.25) : 1;
          data[offset + i] += state * gain * fade;
        }
      };
      add(directDelay, 1, 0);
      reflections.forEach((reflection, index) => {
        if (reflection.gain <= 0.001) return;
        const skew = channel === 0 ? 1 : 1 + 0.07 * (index + 1);
        add(directDelay + Math.round(sampleRate * reflection.seconds * skew), reflection.gain * (index % 2 ? -1 : 1), 0.35 + index * 0.12);
      });
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

  const position = parameter(cabValues, 'position', 48);
  const distance = parameter(cabValues, 'distance', 18);
  const room = parameter(cabValues, 'room', 10);

  if (cab.voicing.impulseSeconds <= 0) {
    // Direct / full range: only a gentle safety roll-off.
    const safety = context.createBiquadFilter();
    safety.type = 'lowpass';
    safety.frequency.value = cab.voicing.highCut;
    safety.Q.value = 0.6;
    master.connect(safety);
    return safety;
  }
  const convolver = context.createConvolver();
  convolver.normalize = true;
  convolver.buffer = makeCabinetImpulse(context, cab, position, distance, room);
  master.connect(convolver);
  return convolver;
}

function connectBoardGraph(
  context: BaseAudioContext,
  input: AudioNode,
  config: BoardAudioConfig,
  scheduled: AudioScheduledSourceNode[],
  namNodes: ReadonlyMap<string, AudioWorkletNode> = new Map(),
  slots?: Map<string, EffectSlot>,
) {
  if (config.mode === 'dry') return input;
  const routes = partitionChain(config.chain, config.routing.mode);
  let effected: AudioNode;

  if (config.routing.mode === 'serial') {
    effected = connectEffectChain(context, input, config, scheduled, routes.serial, namNodes, slots);
  } else {
    const sum = context.createGain();
    const laneMix = computeLaneMix(config.routing.blend, config.routing.spread);
    (['A', 'B'] as const).forEach((lane) => {
      const laneInput = context.createGain();
      const laneGain = context.createGain();
      const lanePan = context.createStereoPanner();
      input.connect(laneInput);
      const laneOutput = connectEffectChain(context, laneInput, config, scheduled, routes[lane], namNodes, slots);
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

/**
 * Output knob to master gain. With the true-peak limiter in place the range
 * is ~10 dB hotter (the old path relied on heavy bus compression instead).
 */
function masterLevel(outputValue: number, limited: boolean) {
  const knob = clampParameter(outputValue) / 100;
  return limited ? 0.12 + knob * 1.1 : 0.04 + knob * 0.34;
}

function connectMaster(
  context: BaseAudioContext,
  input: AudioNode,
  outputValue: number,
): { level: GainNode; output: AudioNode; limited: boolean } {
  const level = context.createGain();
  const limiter = makeFxNode(context, 'sonic-limiter', { ceilingDb: -1, releaseMs: 80 });
  level.gain.value = masterLevel(outputValue, Boolean(limiter));
  if (limiter) {
    // Gentle glue compression, the output level, then a true-peak ceiling.
    const glue = context.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    input.connect(glue).connect(level).connect(limiter);
    return { level, output: limiter, limited: true };
  }
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -8;
  compressor.knee.value = 6;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  input.connect(compressor).connect(level);
  return { level, output: level, limited: false };
}

/** Crossfade length for graph and slot swaps: short enough to feel instant. */
const SWAP_FADE_SECONDS = 0.03;
/** Longest delay/reverb tail a retired graph or slot is kept ringing for. */
const MAX_TAIL_SECONDS = 10;
/** Retired slot instances allowed to ring at once while a knob is dragged. */
const MAX_RINGING_INSTANCES = 2;

type SlotInstance = {
  /** Input gate: closing it silences the effect but lets its tail decay. */
  gate: GainNode;
  /** Output gate: closing it cuts the tail (used to cap ringing instances). */
  tail: GainNode;
  build: EffectBuild;
  out: AudioNode;
};

/**
 * One effect instance in a live graph. Knob changes either message the
 * running node (worklets, NAM gains) or swap in a rebuilt instance with an
 * input crossfade, so neighbouring pedals and tails are never interrupted.
 */
export type EffectSlot = {
  item: AudioChainItem;
  upstream: AudioNode;
  output: GainNode;
  values: Record<string, number>;
  current: SlotInstance;
  ringing: SlotInstance[];
  failed: boolean;
};

function disposeWorklet(node: AudioWorkletNode) {
  try { node.port.postMessage({ type: 'dispose' }); } catch { /* worklet already gone */ }
  try { node.disconnect(); } catch { /* never connected */ }
}

function stopScheduled(nodes: AudioScheduledSourceNode[]) {
  nodes.forEach((node) => {
    try { node.stop(); } catch { /* already stopped */ }
    try { node.disconnect(); } catch { /* never connected */ }
  });
}

function createSlotInstance(
  context: BaseAudioContext,
  upstream: AudioNode,
  output: AudioNode,
  item: AudioChainItem,
  values: Record<string, number>,
  namNodes: ReadonlyMap<string, AudioWorkletNode>,
): SlotInstance {
  const gate = context.createGain();
  const tail = context.createGain();
  upstream.connect(gate);
  const build = newEffectBuild(item.specId);
  const out = buildEffect(context, gate, item, values, build.scheduled, namNodes, build);
  out.connect(tail).connect(output);
  return { gate, tail, build, out };
}

function createEffectSlot(
  context: BaseAudioContext,
  upstream: AudioNode,
  item: AudioChainItem,
  values: Record<string, number>,
  namNodes: ReadonlyMap<string, AudioWorkletNode>,
): EffectSlot {
  const output = context.createGain();
  return {
    item,
    upstream,
    output,
    values,
    current: createSlotInstance(context, upstream, output, item, values, namNodes),
    ringing: [],
    failed: false,
  };
}

/** Releases an instance. Shared NAM nodes are only detached, never disposed. */
function disposeSlotInstance(upstream: AudioNode | null, instance: SlotInstance) {
  stopScheduled(instance.build.scheduled);
  instance.build.worklets.forEach(disposeWorklet);
  if (instance.build.nam) {
    try { instance.build.nam.input.disconnect(); } catch { /* already detached */ }
    try { instance.build.nam.node.disconnect(instance.build.nam.output); } catch { /* already detached */ }
  }
  try { upstream?.disconnect(instance.gate); } catch { /* already detached */ }
  try { instance.gate.disconnect(); } catch { /* already detached */ }
  try { instance.out.disconnect(); } catch { /* already detached */ }
  try { instance.tail.disconnect(); } catch { /* already detached */ }
}

function rampTo(param: AudioParam, value: number, at: number, seconds = SWAP_FADE_SECONDS) {
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(value, at + seconds);
}

function slotTailSeconds(item: AudioChainItem, values: Record<string, number>) {
  const seconds = estimateTailSeconds([item], { [item.instanceId]: values }, new Set(), { mode: 'wet' });
  return Math.min(MAX_TAIL_SECONDS, Math.max(0.05, seconds));
}

function sameValues(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function circuitKnobs(specId: string, values: Record<string, number>) {
  const circuit = CIRCUIT_MODELS[specId];
  const spec = getEffectSpec(specId);
  const knob = (id: string) => parameter(values, id, spec.controls.find((control) => control.id === id)?.defaultValue ?? 50) / 100;
  return {
    controls: circuit.controls.map(knob),
    switches: (circuit.switches ?? []).map((id) => (knob(id) >= 0.5 ? 1 : 0)),
  };
}

function pedalKernelControls(specId: string, values: Record<string, number>) {
  const model = PEDALKERNEL_MODELS[specId];
  return model.controls.map((id) => {
    const fallback = getEffectSpec(specId).controls.find((control) => control.id === id)?.defaultValue ?? 50;
    return parameter(values, id, fallback) / 100;
  });
}

function updateEffectSlot(session: LiveAudioSession, slot: EffectSlot, values: Record<string, number>, namNodes: ReadonlyMap<string, AudioWorkletNode>) {
  if (sameValues(slot.values, values)) return;
  const context = session.context;
  const build = slot.current.build;
  const specId = slot.item.specId;
  const now = context.currentTime;
  const worklet = build.worklets[0];

  if (build.engine === 'circuit' && worklet) {
    // The solver keeps its state; the worklet smooths the new pot values.
    const knobs = circuitKnobs(specId, values);
    knobs.controls.forEach((value, index) => worklet.port.postMessage({ type: 'control', index, value }));
    knobs.switches.forEach((value, index) => worklet.port.postMessage({ type: 'switch', index, value }));
  } else if (build.engine === 'pedalkernel' && worklet) {
    pedalKernelControls(specId, values).forEach((value, index) => worklet.port.postMessage({ type: 'control', index, value }));
  } else if (build.engine === 'nam' && build.nam) {
    const mix = parameter(values, 'mix', 100) / 100;
    build.nam.input.gain.setTargetAtTime(dbToGain(physical(specId, values, 'input', 0)), now, 0.015);
    build.nam.output.gain.setTargetAtTime(dbToGain(physical(specId, values, 'output', 0)), now, 0.015);
    build.nam.dry.gain.setTargetAtTime(Math.cos(mix * Math.PI * 0.5), now, 0.015);
    build.nam.wet.gain.setTargetAtTime(Math.sin(mix * Math.PI * 0.5), now, 0.015);
  } else if (build.update) {
    build.update(values);
  } else if (build.engine !== 'passthrough') {
    // Web Audio models: build the new instance beside the old one, crossfade
    // their inputs, and let the old instance's tail ring out before release.
    const next = createSlotInstance(context, slot.upstream, slot.output, slot.item, values, namNodes);
    next.gate.gain.setValueAtTime(0, now);
    next.gate.gain.linearRampToValueAtTime(1, now + SWAP_FADE_SECONDS);
    const old = slot.current;
    rampTo(old.gate.gain, 0, now);
    slot.ringing.push(old);
    // Dragging a reverb knob would otherwise stack many ringing convolvers.
    while (slot.ringing.length > MAX_RINGING_INSTANCES) {
      const oldest = slot.ringing.shift()!;
      rampTo(oldest.tail.gain, 0, now);
      setTimeout(() => disposeSlotInstance(slot.upstream, oldest), SWAP_FADE_SECONDS * 1000 + 50);
    }
    const ringSeconds = SWAP_FADE_SECONDS + slotTailSeconds(slot.item, slot.values);
    setTimeout(() => {
      const index = slot.ringing.indexOf(old);
      if (index < 0) return;
      slot.ringing.splice(index, 1);
      disposeSlotInstance(slot.upstream, old);
    }, ringSeconds * 1000 + 50);
    slot.current = next;
    watchSlot(session, slot);
  }
  slot.values = values;
}

/** Worklets report a runtime fallback (solver blew up) so the UI can show it. */
function watchSlot(session: LiveAudioSession, slot: EffectSlot) {
  slot.current.build.worklets.forEach((node) => {
    node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== 'fallback') return;
      slot.failed = true;
      publishStatus(session);
    };
  });
}

function publishStatus(session: LiveAudioSession) {
  const status = new Map<string, EffectStatus>();
  session.graph?.slots.forEach((slot, id) => {
    status.set(id, slot.failed ? 'fallback' : slot.current.build.engine === 'passthrough' ? 'passthrough' : 'ok');
  });
  session.status = status;
  session.onStatus?.(status);
}

/** Changes that need a new graph; everything else is applied in place. */
function structureKey(config: BoardAudioConfig) {
  return JSON.stringify({
    chain: config.chain.map((item) => [item.instanceId, item.specId, item.lane ?? null]),
    bypassed: [...config.bypassed].sort(),
    source: sourceConfigKey(config.source),
    mode: config.mode,
    routing: config.routing,
    amp: config.amp,
    nam: Object.entries(config.namModels ?? {}).map(([slot, model]) => [slot, model.modelJson.length]),
  });
}

/** Loads only the worklet runtimes the active chain needs. */
async function prepareProcessorsFor(context: BaseAudioContext, config: BoardAudioConfig) {
  const fx = prepareFxProcessor(context);
  if (config.mode === 'dry') return fx;
  const bypassed = new Set(config.bypassed);
  const active = config.chain.filter((item) => !bypassed.has(item.instanceId)).map((item) => item.specId);
  const jobs: Promise<void>[] = [fx];
  if (active.includes('noise-gate')) jobs.push(prepareNoiseGateProcessor(context));
  const needsCircuit = active.some((id) => CIRCUIT_EFFECT_IDS.has(id));
  if (needsCircuit) jobs.push(prepareCircuitProcessor(context));
  if (active.some((id) => PEDALKERNEL_EFFECT_IDS.has(id) && !CIRCUIT_EFFECT_IDS.has(id))) {
    jobs.push(preparePedalKernelProcessor(context));
  }
  await Promise.all(jobs);
  // Circuit pedals fall back to PedalKernel only if the circuit runtime failed.
  if (needsCircuit && !circuitReady.has(context) && active.some((id) => CIRCUIT_EFFECT_IDS.has(id) && PEDALKERNEL_MODELS[id])) {
    await preparePedalKernelProcessor(context);
  }
}

function buildLiveGraph(
  session: LiveAudioSession,
  config: BoardAudioConfig,
  buffer: AudioBuffer,
  offsetSeconds: number,
  namNodes: Map<string, AudioWorkletNode>,
): LiveGraph {
  const context = session.context;
  const source = context.createBufferSource();
  const input = context.createGain();
  const fade = context.createGain();
  const scheduled: AudioScheduledSourceNode[] = [];
  const slots = new Map<string, EffectSlot>();
  let level: GainNode | null = null;
  let masterOutput: AudioNode | null = null;
  try {
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = buffer.duration;
    if (session.liveInput) session.liveInput.output.connect(input);
    else source.connect(input);
    const effected = connectBoardGraph(context, input, config, scheduled, namNodes, slots);
    const master = connectMaster(context, effected, config.output);
    level = master.level;
    masterOutput = master.output;
    const now = context.currentTime;
    fade.gain.setValueAtTime(0, now);
    fade.gain.linearRampToValueAtTime(1, now + SWAP_FADE_SECONDS);
    master.output.connect(fade).connect(context.destination);
    source.start(0, offsetSeconds % buffer.duration);
  } catch (error) {
    stopScheduled(scheduled);
    slots.forEach((slot) => disposeSlotInstance(slot.upstream, slot.current));
    try { source.stop(); } catch { /* not started */ }
    source.disconnect();
    level?.disconnect();
    if (masterOutput && masterOutput !== level) disposeWorklet(masterOutput as AudioWorkletNode);
    fade.disconnect();
    throw error;
  }
  const graph: LiveGraph = {
    config,
    structureKey: structureKey(config),
    source,
    input,
    level,
    masterOutput: masterOutput ?? level,
    fade,
    scheduled,
    slots,
    namNodes,
  };
  slots.forEach((slot) => watchSlot(session, slot));
  return graph;
}

/** Tears a graph down immediately. NAM nodes still cached are kept. */
function disposeGraph(session: LiveAudioSession, graph: LiveGraph) {
  try { graph.source.stop(); } catch { /* already stopped */ }
  try { graph.source.disconnect(); } catch { /* already detached */ }
  try { graph.input.disconnect(); } catch { /* already detached */ }
  try { session.liveInput?.output.disconnect(graph.input); } catch { /* was not connected */ }
  stopScheduled(graph.scheduled);
  graph.slots.forEach((slot) => {
    disposeSlotInstance(slot.upstream, slot.current);
    slot.ringing.forEach((instance) => disposeSlotInstance(slot.upstream, instance));
    slot.ringing = [];
    try { slot.output.disconnect(); } catch { /* already detached */ }
  });
  try { graph.level.disconnect(); } catch { /* already detached */ }
  if (graph.masterOutput !== graph.level) disposeWorklet(graph.masterOutput as AudioWorkletNode);
  try { graph.fade.disconnect(); } catch { /* already detached */ }
  const cached = new Set([...session.namCache.values()].map((entry) => entry.node));
  graph.namNodes.forEach((node) => { if (!cached.has(node)) disposeNamNode(node); });
}

/** Stops the graph's source but keeps its effects running until tails decay. */
function retireGraph(session: LiveAudioSession, graph: LiveGraph) {
  const context = session.context;
  const now = context.currentTime;
  rampTo(graph.input.gain, 0, now);
  try { graph.source.stop(now + SWAP_FADE_SECONDS + 0.01); } catch { /* already stopped */ }
  session.retiring.add(graph);
  // Rapid structural edits: only the newest retired graph keeps ringing.
  if (session.retiring.size > 1) {
    const [oldest] = session.retiring;
    session.retiring.delete(oldest);
    rampTo(oldest.fade.gain, 0, now);
    setTimeout(() => disposeGraph(session, oldest), SWAP_FADE_SECONDS * 1000 + 50);
  }
  const bypassed = new Set(graph.config.bypassed);
  const tail = Math.min(MAX_TAIL_SECONDS, estimateTailSeconds(graph.config.chain, graph.config.values, bypassed, {
    mode: graph.config.mode,
    routing: graph.config.routing,
  }));
  setTimeout(() => {
    if (!session.retiring.delete(graph)) return;
    disposeGraph(session, graph);
  }, (SWAP_FADE_SECONDS + tail) * 1000 + 100);
}

function pruneNamCache(session: LiveAudioSession, active: ReadonlyMap<string, AudioWorkletNode>) {
  session.namCache.forEach((entry, instanceId) => {
    if (active.get(instanceId) === entry.node) return;
    session.namCache.delete(instanceId);
    disposeNamNode(entry.node);
  });
}

function installGraph(
  session: LiveAudioSession,
  config: BoardAudioConfig,
  buffer: AudioBuffer,
  offsetSeconds: number,
  namNodes: Map<string, AudioWorkletNode>,
) {
  const next = buildLiveGraph(session, config, buffer, offsetSeconds, namNodes);
  const previous = session.graph;
  session.graph = next;
  if (previous) retireGraph(session, previous);
  pruneNamCache(session, namNodes);
  session.startedAt = session.context.currentTime - (offsetSeconds % buffer.duration);
  session.duration = buffer.duration;
  session.sourceKey = sourceConfigKey(config.source);
  publishStatus(session);
}

function applyParameterChanges(session: LiveAudioSession, graph: LiveGraph, config: BoardAudioConfig) {
  const now = session.context.currentTime;
  graph.level.gain.setTargetAtTime(masterLevel(config.output, graph.masterOutput !== graph.level), now, 0.015);
  graph.slots.forEach((slot, instanceId) => {
    updateEffectSlot(session, slot, config.values[instanceId] ?? {}, graph.namNodes);
  });
  graph.config = config;
}

/** Stops every graph immediately (session teardown). */
export function stopLiveGraph(session: LiveAudioSession) {
  session.retiring.forEach((graph) => disposeGraph(session, graph));
  session.retiring.clear();
  if (session.graph) disposeGraph(session, session.graph);
  session.graph = null;
}

/**
 * iOS suspends (or reports 'interrupted') an AudioContext on calls, Siri, or
 * when the tab is backgrounded, and does not resume it by itself. Try again
 * when the page is visible and on the next touch, which counts as a gesture.
 */
function keepContextRunning(context: AudioContext) {
  const resume = () => {
    if (document.visibilityState !== 'visible') return;
    const state = context.state as string;
    if (state === 'suspended' || state === 'interrupted') void context.resume().catch(() => { /* retried on the next gesture */ });
  };
  context.addEventListener('statechange', resume);
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pointerdown', resume, true);
  return () => {
    context.removeEventListener('statechange', resume);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pointerdown', resume, true);
  };
}

export async function createLiveSession(config: BoardAudioConfig) {
  const AudioContextClass = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持音频预览');
  const context = new AudioContextClass({ latencyHint: 'interactive' });
  const session: LiveAudioSession = {
    context,
    graph: null,
    retiring: new Set(),
    buffers: new Map(),
    bufferLoads: new Map(),
    startedAt: 0,
    duration: SOURCE_DURATION_SECONDS,
    sourceKey: sourceConfigKey(config.source),
    revision: 0,
    namCache: new Map(),
    status: new Map(),
  };
  session.detachResume = keepContextRunning(context);
  try {
    activateMobileAudio(context, window.navigator);
    await context.resume();
    await prepareProcessorsFor(context, config);
    const namNodes = await prepareNamNodes(context, config, session.namCache);
    const buffer = await loadSessionBuffer(session, session.sourceKey, config.source);
    rememberSessionBuffer(session, session.sourceKey, buffer);
    installGraph(session, config, buffer, 0, namNodes);
    return session;
  } catch (error) {
    stopLiveGraph(session);
    session.namCache.forEach((entry) => disposeNamNode(entry.node));
    session.detachResume?.();
    try { await context.close(); } catch { /* preserve the original creation failure */ }
    throw error;
  }
}

/**
 * Applies a new board configuration. Knob moves are applied in place without
 * interrupting audio; structural edits build a new graph that fades in while
 * the old one's delay and reverb tails ring out.
 */
export async function refreshLiveSession(session: LiveAudioSession, config: BoardAudioConfig) {
  if (isClosedAudioContext(session.context)) return;
  const key = structureKey(config);
  if (session.pendingStructure !== undefined) {
    // A rebuild for this structure is in flight: it will use the newest values.
    if (session.pendingStructure === key) {
      session.pendingConfig = config;
      return;
    }
  } else if (session.graph && session.graph.structureKey === key) {
    applyParameterChanges(session, session.graph, config);
    return;
  }
  // Structural rebuild. Knob changes arriving meanwhile update the target.
  session.pendingConfig = config;
  session.pendingStructure = key;
  const revision = ++session.revision;
  try {
    await prepareProcessorsFor(session.context, config);
    const namNodes = await prepareNamNodes(session.context, config, session.namCache);
    const sourceKey = sourceConfigKey(config.source);
    const offset = sourceKey === session.sourceKey
      ? (session.context.currentTime - session.startedAt) % session.duration
      : 0;
    const buffer = await loadSessionBuffer(session, sourceKey, config.source);
    if (session.revision !== revision || isClosedAudioContext(session.context)) return;
    rememberSessionBuffer(session, sourceKey, buffer);
    installGraph(session, session.pendingConfig ?? config, buffer, offset, namNodes);
  } finally {
    if (session.revision === revision) {
      session.pendingConfig = undefined;
      session.pendingStructure = undefined;
    }
  }
}

/**
 * Routes a live instrument (audio interface or microphone) into the board in
 * place of the DI sample, or back to the sample when `stream` is null. Only
 * the first input channel is used: interfaces put the instrument jack on 1.
 */
export function setLiveInput(session: LiveAudioSession, stream: MediaStream | null) {
  const context = session.context;
  const graph = session.graph;
  const previous = session.liveInput;
  if (previous) {
    if (graph) try { previous.output.disconnect(graph.input); } catch { /* not connected */ }
    closeLiveInput(previous);
    session.liveInput = undefined;
  }
  if (stream) {
    const source = context.createMediaStreamSource(stream);
    const splitter = context.createChannelSplitter(Math.max(1, source.channelCount));
    const output = context.createGain();
    source.connect(splitter);
    splitter.connect(output, 0);
    session.liveInput = { stream, source, output };
  }
  if (!graph) return;
  const now = context.currentTime;
  // Short dip so switching sources does not click.
  graph.input.gain.cancelScheduledValues(now);
  graph.input.gain.setValueAtTime(0, now);
  graph.input.gain.linearRampToValueAtTime(1, now + SWAP_FADE_SECONDS);
  if (session.liveInput) {
    try { graph.source.disconnect(graph.input); } catch { /* not connected */ }
    session.liveInput.output.connect(graph.input);
  } else {
    graph.source.connect(graph.input);
  }
}

function closeLiveInput(input: LiveInput) {
  try { input.source.disconnect(); } catch { /* already detached */ }
  try { input.output.disconnect(); } catch { /* already detached */ }
  input.stream.getTracks().forEach((track) => track.stop());
}

/** Asks for an instrument input with the browser's voice processing turned off. */
export async function requestInstrumentStream(mediaDevices: MediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持实时输入');
  return mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
    video: false,
  });
}

export async function disposeLiveSession(session: LiveAudioSession | null) {
  if (!session) return;
  session.revision += 1;
  session.detachResume?.();
  session.detachResume = undefined;
  if (session.liveInput) {
    closeLiveInput(session.liveInput);
    session.liveInput = undefined;
  }
  stopLiveGraph(session);
  session.namCache.forEach((entry) => disposeNamNode(entry.node));
  session.namCache.clear();
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
  await prepareProcessorsFor(offline, config);
  const namNodes = await prepareNamNodes(offline, config);
  const source = offline.createBufferSource();
  const input = offline.createGain();
  const scheduled: AudioScheduledSourceNode[] = [];
  source.buffer = await makeAudioBuffer(offline, config.source);
  source.connect(input);
  const effected = connectBoardGraph(offline, input, config, scheduled, namNodes);
  connectMaster(offline, effected, config.output).output.connect(offline.destination);
  source.start(0);
  let rendered: AudioBuffer;
  try {
    rendered = await offline.startRendering();
  } finally {
    disposeNamNodes(namNodes);
  }
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index));
  const exportChannels = config.mode === 'wet'
    ? trimRenderedTail(channels, rendered.sampleRate)
    : channels;
  // 24-bit keeps the quiet tails of reverbs and delays free of quantisation grit.
  return new Blob([encodePcmWav(exportChannels, rendered.sampleRate, { bits: 24 })], { type: 'audio/wav' });
}
