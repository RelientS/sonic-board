import { EnvelopeNoiseGate } from './noise-gate-dsp.js';

class SonicNoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'thresholdDb', defaultValue: -55, minValue: -72, maxValue: -12, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 180, minValue: 20, maxValue: 1200, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.gate = new EnvelopeNoiseGate(sampleRate);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const frameCount = output[0]?.length ?? 0;
    const thresholdDb = parameters.thresholdDb[0];
    const releaseMs = parameters.releaseMs[0];

    for (let frame = 0; frame < frameCount; frame += 1) {
      let detector = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        detector = Math.max(detector, Math.abs(input[channel]?.[frame] ?? 0));
      }
      const gain = this.gate.processFrame(detector, thresholdDb, releaseMs);
      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceChannel = input[channel] ?? input[0];
        output[channel][frame] = (sourceChannel?.[frame] ?? 0) * gain;
      }
    }
    return true;
  }
}

registerProcessor('sonic-noise-gate', SonicNoiseGateProcessor);
