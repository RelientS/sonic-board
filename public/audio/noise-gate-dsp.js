export class EnvelopeNoiseGate {
  constructor(processorSampleRate) {
    this.sampleRate = Math.max(1, processorSampleRate);
    this.envelope = 0;
    this.gain = 0;
    this.open = false;
    this.detectorAttack = Math.exp(-1 / (0.0015 * this.sampleRate));
    this.detectorRelease = Math.exp(-1 / (0.02 * this.sampleRate));
    this.gainAttack = Math.exp(-1 / (0.002 * this.sampleRate));
  }

  processFrame(detector, thresholdDb, releaseMs) {
    const magnitude = Math.abs(Number.isFinite(detector) ? detector : 0);
    const detectorCoefficient = magnitude > this.envelope
      ? this.detectorAttack
      : this.detectorRelease;
    this.envelope = magnitude + detectorCoefficient * (this.envelope - magnitude);

    const safeThresholdDb = Math.min(0, Math.max(-96, thresholdDb));
    const threshold = 10 ** (safeThresholdDb / 20);
    if (this.open) {
      if (this.envelope < threshold * 0.5) this.open = false;
    } else if (this.envelope >= threshold) {
      this.open = true;
    }

    const target = this.open ? 1 : 0;
    const safeReleaseSeconds = Math.min(3, Math.max(0.005, releaseMs / 1000));
    const coefficient = target > this.gain
      ? this.gainAttack
      : Math.exp(-1 / (safeReleaseSeconds * this.sampleRate));
    this.gain = target + coefficient * (this.gain - target);
    if (this.gain < 0.000001) this.gain = 0;
    return this.gain;
  }
}
