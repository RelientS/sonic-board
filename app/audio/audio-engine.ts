import {
  clampParameter,
  encodePcm16Wav,
  estimateTailSeconds,
  makeDriveCurve,
  makeGateCurve,
  makeNoiseGateCurve,
  SOURCE_DURATION_SECONDS,
  synthesizeSourceChannels,
  type AudioChainItem,
  type AudioValues,
  type RoutingConfig,
  type SourceConfig,
} from './audio-core.ts';
import { sourceConfigKey } from './source-catalog.ts';
import { renderSampledSourceBuffer } from './sample-renderer.ts';
import { getEffectSpec, mapControlValue } from '../effects/catalog.ts';
import { EFFECT_FIDELITY_PROFILES, type EffectFidelityProfile } from '../effects/fidelity.ts';
import { AMP_SPECS, CAB_SPECS, getAmpSpec, getCabSpec, type AmpCabConfig } from '../amps/catalog.ts';
import { computeLaneMix, partitionChain } from './routing.ts';

export const SUPPORTED_EFFECT_IDS = new Set([
  'studio-comp', 'noise-gate', 'graphic-eq',
  'blue-drive', 'rodent-dist', 'wall-fuzz', 'chainsaw-dist',
  'slow-phase', 'analog-chorus', 'jet-flanger', 'tape-vibrato', 'bias-tremolo', 'soft-detune',
  'analog-delay', 'tape-echo', 'digital-delay',
  'reverse-space', 'gated-room', 'cloud-hall',
]);
export const SUPPORTED_AMP_IDS = new Set(AMP_SPECS.map((amp) => amp.id));
export const SUPPORTED_CAB_IDS = new Set(CAB_SPECS.map((cab) => cab.id));
export const PEDALKERNEL_EFFECT_IDS: ReadonlySet<string> = new Set([
  'studio-comp', 'rodent-dist',
]);
export { EFFECT_FIDELITY_PROFILES, type EffectFidelityProfile };

const noiseGateReady = new WeakSet<BaseAudioContext>();
const noiseGateLoading = new WeakMap<BaseAudioContext, Promise<void>>();
const pedalKernelReady = new WeakSet<BaseAudioContext>();
const pedalKernelLoading = new WeakMap<BaseAudioContext, Promise<void>>();
const pedalKernelModules = new WeakMap<BaseAudioContext, WebAssembly.Module>();
let pedalKernelModulePromise: Promise<WebAssembly.Module> | null = null;

const PEDALKERNEL_MODELS: Record<string, { modelId: number; controls: string[] }> = {
  'studio-comp': { modelId: 0, controls: ['sustain', 'level'] },
  'blue-drive': { modelId: 1, controls: ['gain', 'tone', 'level'] },
  'rodent-dist': { modelId: 2, controls: ['distortion', 'filter', 'volume'] },
  'wall-fuzz': { modelId: 3, controls: ['sustain', 'tone', 'volume'] },
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

async function preparePedalKernelProcessor(context: BaseAudioContext) {
  if (pedalKernelReady.has(context)) return;
  const worklet = (context as BaseAudioContext & {
    audioWorklet?: { addModule: (moduleUrl: string) => Promise<void> };
  }).audioWorklet;
  if (!worklet || typeof AudioWorkletNode === 'undefined') return;
  let pending = pedalKernelLoading.get(context);
  if (!pending) {
    pedalKernelModulePromise ??= fetch('/audio/pedalkernel.wasm')
      .then((response) => {
        if (!response.ok) throw new Error(`PedalKernel WASM ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes));
    pending = Promise.all([
      pedalKernelModulePromise,
      worklet.addModule('/audio/pedalkernel-processor.js'),
    ]).then(([module]) => {
      pedalKernelModules.set(context, module);
      pedalKernelReady.add(context);
    }).catch(() => {
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
    const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
    channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
    return buffer;
  }
}

function makeImpulse(
  context: BaseAudioContext,
  seconds: number,
  kind: 'decay' | 'reverse' | 'gate',
  seed: number,
  density = 100,
) {
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
        modelId: model.modelId,
        controls: model.controls.map((id) => parameter(values, id, 50) / 100),
      },
    });
  } catch {
    return null;
  }
}

function connectEffectChain(
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
      if (noiseGateReady.has(context) && typeof AudioWorkletNode !== 'undefined') {
        const gate = new AudioWorkletNode(context, 'sonic-noise-gate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          parameterData: {
            thresholdDb,
            releaseMs,
          },
        });
        cursor.connect(gate).connect(output);
      } else {
        const fallbackGate = context.createWaveShaper();
        fallbackGate.curve = makeNoiseGateCurve(thresholdDb);
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
      shaper.curve = makeDriveCurve(specId === 'blue-drive' ? drive * 0.58 : drive * 1.08);
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
      gate.curve = makeGateCurve(parameter(values, 'gate', 8) * 0.65);
      shaper.curve = makeDriveCurve(sustain * 1.15);
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

    if (specId === 'chainsaw-dist') {
      const preGain = context.createGain();
      const shaper = context.createWaveShaper();
      const low = context.createBiquadFilter();
      const highMid = context.createBiquadFilter();
      const presence = context.createBiquadFilter();
      const output = context.createGain();
      const distortion = parameter(values, 'distortion', 78);
      preGain.gain.value = 2.4 + distortion / 8;
      shaper.curve = makeDriveCurve(distortion * 1.2);
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
      shape.curve = makeDriveCurve(parameter(values, 'wave', 35) * 0.75, 1024);
      modulation.gain.value = depth * 0.5;
      lfo.connect(shape).connect(modulation).connect(tremolo.gain);
      lfo.start(0); scheduled.push(lfo);
      const output = context.createGain();
      output.gain.value = dbToGain(physical(specId, values, 'level', 0));
      cursor.connect(tremolo).connect(output);
      cursor = output;
      return;
    }

    if (specId === 'analog-delay' || specId === 'tape-echo') {
      const delay = context.createDelay(1.3);
      const feedback = context.createGain();
      const damping = context.createBiquadFilter();
      const lfo = context.createOscillator();
      const modulation = context.createGain();
      delay.delayTime.value = physical(specId, values, 'time', 380) / 1000;
      feedback.gain.value = Math.min(0.78, parameter(values, specId === 'tape-echo' ? 'repeats' : 'feedback', 32) / 112);
      damping.type = 'lowpass'; damping.frequency.value = physical(specId, values, 'tone', 3_500);
      lfo.frequency.value = specId === 'tape-echo' ? 0.42 : 0.18;
      modulation.gain.value = parameter(values, specId === 'tape-echo' ? 'wow' : 'mod', 14) / 38_000;
      lfo.connect(modulation).connect(delay.delayTime);
      lfo.start(0); scheduled.push(lfo);
      delay.connect(damping).connect(feedback).connect(delay);
      cursor.connect(delay);
      cursor = mixParallel(context, cursor, delay, parameter(values, 'mix', 28));
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
  });

  return cursor;
}

function makeCabinetImpulse(context: BaseAudioContext, seconds: number, distance: number, room: number, seed: number) {
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
  shaper.curve = makeDriveCurve(Math.max(1, gainValue * amp.voicing.drive));
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

  return connectAmpCab(context, effected, config.amp);
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
  stopLiveGraph(session);
  const key = sourceConfigKey(config.source);
  const source = session.context.createBufferSource();
  const input = session.context.createGain();
  source.buffer = buffer;
  source.loop = true;
  source.loopEnd = buffer.duration;
  source.connect(input);
  const effected = connectBoardGraph(session.context, input, config, session.scheduled);
  const master = connectMaster(session.context, effected, config.output);
  master.connect(session.context.destination);
  const safeOffset = offsetSeconds % buffer.duration;
  source.start(0, safeOffset);
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
  activateMobileAudio(context, window.navigator);
  await context.resume();
  await Promise.all([prepareNoiseGateProcessor(context), preparePedalKernelProcessor(context)]);
  const session: LiveAudioSession = {
    context,
    source: null,
    output: null,
    scheduled: [],
    buffers: new Map(),
    startedAt: 0,
    duration: SOURCE_DURATION_SECONDS,
    sourceKey: sourceConfigKey(config.source),
    revision: 0,
  };
  const buffer = await makeAudioBuffer(context, config.source);
  session.buffers.set(session.sourceKey, buffer);
  startLiveGraph(session, config, 0, buffer);
  return session;
}

export async function refreshLiveSession(session: LiveAudioSession, config: BoardAudioConfig) {
  if (session.context.state === 'closed') return;
  const revision = ++session.revision;
  await Promise.all([prepareNoiseGateProcessor(session.context), preparePedalKernelProcessor(session.context)]);
  const key = sourceConfigKey(config.source);
  const offset = sourceConfigKey(config.source) === session.sourceKey
    ? (session.context.currentTime - session.startedAt) % session.duration
    : 0;
  let buffer = session.buffers.get(key);
  if (!buffer) {
    buffer = await makeAudioBuffer(session.context, config.source);
    session.buffers.set(key, buffer);
  }
  if (session.revision !== revision || session.context.state === 'closed') return;
  startLiveGraph(session, config, offset, buffer);
}

export async function disposeLiveSession(session: LiveAudioSession | null) {
  if (!session) return;
  session.revision += 1;
  stopLiveGraph(session);
  await session.context.close();
}

export async function renderBoardToWav(config: BoardAudioConfig) {
  const sampleRate = 44_100;
  const tail = estimateTailSeconds(config.chain, config.values, new Set(config.bypassed));
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
  return new Blob([encodePcm16Wav(channels, rendered.sampleRate)], { type: 'audio/wav' });
}
