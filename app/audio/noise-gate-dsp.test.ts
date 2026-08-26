import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const moduleUrl = new URL('../../public/audio/noise-gate-dsp.js', import.meta.url);

async function loadGate() {
  assert.ok(existsSync(moduleUrl), 'the envelope noise-gate DSP module should exist');
  const loadedModule = await import(moduleUrl.href) as {
    EnvelopeNoiseGate: new (sampleRate: number) => {
      processFrame: (detector: number, thresholdDb: number, releaseMs: number) => number;
    };
  };
  return loadedModule.EnvelopeNoiseGate;
}

test('default threshold opens for a clean guitar note and preserves its body', async () => {
  const EnvelopeNoiseGate = await loadGate();
  const sampleRate = 48_000;
  const gate = new EnvelopeNoiseGate(sampleRate);
  let inputEnergy = 0;
  let outputEnergy = 0;

  for (let frame = 0; frame < sampleRate / 5; frame += 1) {
    const sample = Math.sin(frame * Math.PI * 2 * 220 / sampleRate) * 0.05;
    const gain = gate.processFrame(Math.abs(sample), -55, 180);
    if (frame > sampleRate * 0.03) {
      inputEnergy += sample * sample;
      outputEnergy += (sample * gain) ** 2;
    }
  }

  assert.ok(Math.sqrt(outputEnergy / inputEnergy) > 0.95);
});

test('release holds the note tail briefly and then closes below the threshold', async () => {
  const EnvelopeNoiseGate = await loadGate();
  const sampleRate = 48_000;
  const gate = new EnvelopeNoiseGate(sampleRate);

  for (let frame = 0; frame < sampleRate * 0.05; frame += 1) {
    gate.processFrame(0.05, -55, 300);
  }
  let gainAfter100ms = 0;
  let gainAfter700ms = 0;
  for (let frame = 0; frame < sampleRate * 0.7; frame += 1) {
    const gain = gate.processFrame(0, -55, 300);
    if (frame === Math.floor(sampleRate * 0.1)) gainAfter100ms = gain;
    if (frame === Math.floor(sampleRate * 0.69)) gainAfter700ms = gain;
  }

  assert.ok(gainAfter100ms > 0.6, 'release should preserve the start of the decay');
  assert.ok(gainAfter700ms < 0.15, 'the gate should eventually suppress steady noise');
});
