import assert from 'node:assert/strict';
import test from 'node:test';

import { stopLiveGraph, type EffectSlot, type LiveAudioSession } from './audio-engine.ts';

function fakeNode(log: string[], name: string) {
  return {
    name,
    disconnect: () => { log.push(`${name}.disconnect`); },
    stop: () => { log.push(`${name}.stop`); },
    port: { postMessage: (message: { type: string }) => { log.push(`${name}.${message.type}`); } },
    gain: { value: 1 },
  };
}

function fakeGraph(log: string[], prefix: string, namNode?: ReturnType<typeof fakeNode>) {
  const worklet = fakeNode(log, `${prefix}.worklet`);
  const slot = {
    upstream: fakeNode(log, `${prefix}.upstream`),
    output: fakeNode(log, `${prefix}.slotOut`),
    current: {
      gate: fakeNode(log, `${prefix}.gate`),
      tail: fakeNode(log, `${prefix}.tail`),
      out: fakeNode(log, `${prefix}.out`),
      build: { specId: 'rodent-dist', engine: 'circuit', worklets: [worklet], scheduled: [fakeNode(log, `${prefix}.lfo`)] },
    },
    ringing: [],
  } as unknown as EffectSlot;
  return {
    source: fakeNode(log, `${prefix}.source`),
    input: fakeNode(log, `${prefix}.input`),
    level: fakeNode(log, `${prefix}.level`),
    fade: fakeNode(log, `${prefix}.fade`),
    scheduled: [],
    slots: new Map([['pedal', slot]]),
    namNodes: new Map(namNode ? [['nam', namNode]] : []),
  };
}

test('stopping a session releases every graph and disposes its worklets so the audio thread is not left running them', () => {
  const log: string[] = [];
  const cachedNam = fakeNode(log, 'cachedNam');
  const current = fakeGraph(log, 'current', cachedNam);
  const retiring = fakeGraph(log, 'retiring');
  const session = {
    graph: current,
    retiring: new Set([retiring]),
    namCache: new Map([['nam', { modelJson: '{}', node: cachedNam }]]),
  } as unknown as LiveAudioSession;

  stopLiveGraph(session);

  assert.equal(session.graph, null);
  assert.equal(session.retiring.size, 0);
  for (const prefix of ['current', 'retiring']) {
    assert.ok(log.includes(`${prefix}.source.stop`), `${prefix} source must stop`);
    assert.ok(log.includes(`${prefix}.worklet.dispose`), `${prefix} worklet must be told to dispose`);
    assert.ok(log.includes(`${prefix}.lfo.stop`), `${prefix} LFOs must stop`);
    assert.ok(log.includes(`${prefix}.fade.disconnect`), `${prefix} output must disconnect`);
  }
  // A NAM node still in the session cache is reused by the next graph.
  assert.ok(!log.includes('cachedNam.dispose'));
});
