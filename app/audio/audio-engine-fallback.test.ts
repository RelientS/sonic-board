import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTailSeconds } from './audio-core.ts';
import {
  connectEffectChain,
  PEDALKERNEL_EFFECT_IDS,
  PEDALKERNEL_FALLBACK_EFFECT_IDS,
  type BoardAudioConfig,
} from './audio-engine.ts';
import { getEffectSpec, makeDefaultValues } from '../effects/catalog.ts';

class FakeAudioParam {
  value = 0;

  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeAudioBuffer {
  readonly duration: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.numberOfChannels = channels;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number) { return this.channels[channel]; }
  copyToChannel(source: Float32Array, channel: number) { this.channels[channel].set(source); }
}

class FakeAudioNode {
  readonly kind: string;
  type = '';
  curve: Float32Array | null = null;
  oversample = 'none';
  buffer: FakeAudioBuffer | null = null;
  normalize = false;
  readonly gain = new FakeAudioParam();
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
  readonly delayTime = new FakeAudioParam();
  readonly pan = new FakeAudioParam();

  constructor(kind: string) { this.kind = kind; }

  connect<T>(target: T) { return target; }
  disconnect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  readonly sampleRate = 48_000;
  readonly currentTime = 0;
  readonly nodes: FakeAudioNode[] = [];

  private node(kind: string) {
    const node = new FakeAudioNode(kind);
    this.nodes.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createGain() { return this.node('gain'); }
  createDynamicsCompressor() { return this.node('compressor'); }
  createBiquadFilter() { return this.node('biquad'); }
  createWaveShaper() { return this.node('waveshaper'); }
  createDelay() { return this.node('delay'); }
  createOscillator() { return this.node('oscillator'); }
  createStereoPanner() { return this.node('panner'); }
  createConvolver() { return this.node('convolver'); }
}

const NEW_FALLBACK_IDS = [
  'dm2-delay',
  'fuzz-face',
  'ocd-drive',
  'klon-centaur',
  'sd1-drive',
  'tube-screamer',
  'phase90',
] as const;

function configFor(specId: string, values = makeDefaultValues(specId)): BoardAudioConfig {
  return {
    chain: [{ instanceId: `${specId}-1`, specId }],
    values: { [`${specId}-1`]: values },
    bypassed: [],
    source: { guitar: 'single-neck', performance: 'chords', progression: 'dream-open' },
    mode: 'wet',
    output: 65,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: {
      ampId: 'american-twin',
      cabId: 'open-2x12',
      ampValues: {},
      cabValues: {},
      bypassed: true,
    },
  };
}

function renderFallback(specId: string, values = makeDefaultValues(specId)) {
  const context = new FakeAudioContext();
  const input = new FakeAudioNode('input');
  const scheduled: FakeAudioNode[] = [];
  const output = connectEffectChain(
    context as unknown as BaseAudioContext,
    input as unknown as AudioNode,
    configFor(specId, values),
    scheduled as unknown as AudioScheduledSourceNode[],
  );
  return { context, input, output };
}

function graphSignature(nodes: FakeAudioNode[]) {
  return JSON.stringify(nodes.map((node) => ({
    kind: node.kind,
    type: node.type,
    gain: node.gain.value,
    frequency: node.frequency.value,
    q: node.Q.value,
    delay: node.delayTime.value,
    pan: node.pan.value,
    curve: node.curve ? [
      node.curve.length,
      node.curve[Math.floor(node.curve.length * 0.25)],
      node.curve[Math.floor(node.curve.length * 0.375)],
    ] : null,
  })));
}

test('every PedalKernel model has a real no-worklet fallback graph', () => {
  assert.deepEqual([...PEDALKERNEL_FALLBACK_EFFECT_IDS].sort(), [...PEDALKERNEL_EFFECT_IDS].sort());

  for (const specId of PEDALKERNEL_EFFECT_IDS) {
    const { context, input, output } = renderFallback(specId);
    assert.notEqual(output, input, `${specId} fell through as dry passthrough`);
    assert.ok(context.nodes.length > 0, `${specId} created no legacy Web Audio nodes`);
  }
});

test('every exposed control changes each newly added PedalKernel fallback', () => {
  for (const specId of NEW_FALLBACK_IDS) {
    const defaults = makeDefaultValues(specId);
    const baseline = graphSignature(renderFallback(specId, defaults).context.nodes);
    for (const control of getEffectSpec(specId).controls) {
      const changedValue = control.defaultValue < 50 ? 90 : 10;
      const changed = graphSignature(renderFallback(specId, { ...defaults, [control.id]: changedValue }).context.nodes);
      assert.notEqual(changed, baseline, `${specId}.${control.id} did not change its fallback graph`);
    }
  }
});

test('DM-2 fallback timing matches the export tail estimate', () => {
  const values = { time: 72, repeats: 68, mix: 40 };
  const { context } = renderFallback('dm2-delay', values);
  const delay = context.nodes.find((node) => node.kind === 'delay');
  const feedback = context.nodes.find((node) => node.kind === 'gain');
  assert.ok(delay);
  assert.ok(feedback);

  const repeatsUntilQuiet = Math.log(0.01) / Math.log(feedback.gain.value);
  const graphTail = Math.min(10, delay.delayTime.value * repeatsUntilQuiet);
  const estimated = estimateTailSeconds(
    [{ instanceId: 'dm2-delay-1', specId: 'dm2-delay' }],
    { 'dm2-delay-1': values },
    new Set(),
  );
  assert.equal(estimated, Number(Math.max(0.25, graphTail).toFixed(2)));
});

test('deterministic fallback curves are reused across graph refreshes', () => {
  const context = new FakeAudioContext();
  const scheduled: FakeAudioNode[] = [];
  const config = configFor('fuzz-face');
  connectEffectChain(
    context as unknown as BaseAudioContext,
    new FakeAudioNode('input') as unknown as AudioNode,
    config,
    scheduled as unknown as AudioScheduledSourceNode[],
  );
  const first = context.nodes.find((node) => node.kind === 'waveshaper')?.curve;
  connectEffectChain(
    context as unknown as BaseAudioContext,
    new FakeAudioNode('input') as unknown as AudioNode,
    config,
    scheduled as unknown as AudioScheduledSourceNode[],
  );
  const curves = context.nodes.filter((node) => node.kind === 'waveshaper').map((node) => node.curve);

  assert.ok(first);
  assert.equal(curves.length, 2);
  assert.equal(curves[1], first);
});
