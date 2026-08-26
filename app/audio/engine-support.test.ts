import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AMP_SPECS, CAB_SPECS } from '../amps/catalog.ts';
import { EFFECT_SPECS } from '../effects/catalog.ts';
import * as audioEngine from './audio-engine.ts';
import { SUPPORTED_AMP_IDS, SUPPORTED_CAB_IDS, SUPPORTED_EFFECT_IDS } from './audio-engine.ts';

const engineSource = readFileSync(new URL('./audio-engine.ts', import.meta.url), 'utf8');

test('the audio engine implements every effect exposed by the catalog', () => {
  assert.deepEqual([...SUPPORTED_EFFECT_IDS].sort(), EFFECT_SPECS.map((effect) => effect.id).sort());
});

test('the audio engine implements every amp and cabinet exposed by the catalog', () => {
  assert.deepEqual([...SUPPORTED_AMP_IDS].sort(), AMP_SPECS.map((amp) => amp.id).sort());
  assert.deepEqual([...SUPPORTED_CAB_IDS].sort(), CAB_SPECS.map((cab) => cab.id).sort());
});

test('the audio engine renders real guitar samples and keeps synthesis only as fallback', () => {
  assert.match(engineSource, /renderSampledSourceBuffer/);
  assert.match(engineSource, /catch[\s\S]*synthesizeSourceChannels/);
});

test('noise suppression uses a dB-calibrated envelope worklet instead of sample chopping', () => {
  assert.match(engineSource, /new AudioWorkletNode\(context, 'sonic-noise-gate'/);
  assert.match(engineSource, /const thresholdDb = physical\(specId, values, 'threshold'/);
  assert.match(engineSource, /const releaseMs = physical\(specId, values, 'release'/);
});

test('mobile playback selects the media audio session and primes output synchronously', () => {
  assert.ok('activateMobileAudio' in audioEngine, 'the engine needs an explicit mobile audio activation step');
  const activateMobileAudio = (audioEngine as typeof audioEngine & {
    activateMobileAudio: (context: AudioContext, navigatorObject: Navigator) => void;
  }).activateMobileAudio;
  let starts = 0;
  let resumes = 0;
  const destination = {};
  const source = {
    buffer: null,
    connect: (target: unknown) => assert.equal(target, destination),
    start: () => { starts += 1; },
  };
  const context = {
    sampleRate: 48_000,
    destination,
    createBuffer: (channels: number, frames: number) => {
      assert.equal(channels, 1);
      assert.equal(frames, 1);
      return {};
    },
    createBufferSource: () => source,
    resume: async () => { resumes += 1; },
  } as unknown as AudioContext;
  const navigatorObject = { audioSession: { type: 'ambient' } } as unknown as Navigator;

  activateMobileAudio(context, navigatorObject);

  assert.equal((navigatorObject as Navigator & { audioSession: { type: string } }).audioSession.type, 'playback');
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
});

test('mobile audio activation happens before the first asynchronous resume boundary', () => {
  const createSession = engineSource.slice(engineSource.indexOf('export async function createLiveSession'));
  const activation = createSession.indexOf('activateMobileAudio(context');
  const firstAwait = createSession.indexOf('await context.resume()');
  assert.ok(activation >= 0, 'createLiveSession should activate mobile audio');
  assert.ok(activation < firstAwait, 'activation must remain inside the tap call stack');
});
