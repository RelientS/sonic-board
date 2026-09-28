// Time-based effects and the master limiter, run per sample in the audio
// thread where Web Audio's node graph cannot go (e.g. feedback loops shorter
// than one render quantum). Parameters arrive as {type:'params'} messages;
// {type:'dispose'} ends processing so the node can be collected.

const DENORMAL = 1e-18;

class DelayLine {
  constructor(size) {
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
    this.write = 0;
  }

  push(value) {
    this.buffer[this.write] = value;
    this.write = (this.write + 1) & this.mask;
  }

  /** Sample `delay` samples ago (fractional, cubic Hermite interpolation). */
  read(delay) {
    const position = this.write - 1 - delay;
    const base = Math.floor(position);
    const t = position - base;
    const b = this.buffer;
    const m = this.mask;
    const y0 = b[(base - 1) & m];
    const y1 = b[base & m];
    const y2 = b[(base + 1) & m];
    const y3 = b[(base + 2) & m];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  readInt(delay) {
    return this.buffer[(this.write - 1 - delay) & this.mask];
  }
}

function powerOfTwoAtLeast(value) {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

class BaseFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.disposed = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'dispose') this.disposed = true;
      else if (message?.type === 'params') this.setParams(message.params ?? {});
    };
  }

  setParams() {}
}

/**
 * Feedback delay network reverb: pre-delay, four input diffusers, eight
 * damped delay lines mixed by a Householder matrix, with slow modulation of
 * half the lines. Output is wet only (the dry/wet mix is done outside).
 */
class SonicReverbProcessor extends BaseFx {
  constructor(options) {
    super();
    const scale = sampleRate / 48000;
    this.preDelay = new DelayLine(powerOfTwoAtLeast(Math.ceil(sampleRate * 1.05)));
    this.diffusers = [142, 107, 379, 277].map((length, index) => ({
      line: new DelayLine(powerOfTwoAtLeast(Math.ceil(length * scale) + 4)),
      length: Math.round(length * scale),
      gain: index < 2 ? 0.72 : 0.62,
    }));
    this.baseLengths = [1553, 1693, 1861, 2027, 2203, 2399, 2593, 2797].map((length) => length * scale);
    const maxLength = Math.ceil(this.baseLengths[7] * 1.9) + 64;
    this.lines = this.baseLengths.map(() => new DelayLine(powerOfTwoAtLeast(maxLength)));
    this.damp = new Float32Array(8);
    this.gains = new Float32Array(8);
    this.lengths = new Float32Array(8);
    this.coefficient = 0;
    this.phases = [0.0, 1.7, 3.1, 4.6];
    this.rates = [0.31, 0.47, 0.63, 0.89];
    this.outputs = new Float32Array(8);
    this.params = { decay: 6, preDelay: 0.02, tone: 6000, motion: 0.3, size: 1.3 };
    this.setParams(options.processorOptions ?? {});
  }

  setParams(params) {
    Object.assign(this.params, params);
    const { decay, tone, size } = this.params;
    const rt60 = Math.max(0.2, Math.min(40, decay));
    const scale = Math.max(0.5, Math.min(1.8, size));
    for (let i = 0; i < 8; i += 1) {
      this.lengths[i] = this.baseLengths[i] * scale;
      // Per-line gain for a -60 dB decay after rt60 seconds.
      this.gains[i] = Math.pow(10, (-3 * this.lengths[i]) / (sampleRate * rt60));
    }
    // One-pole damping: the higher the tone, the less the tail darkens.
    const cutoff = Math.max(500, Math.min(16000, tone));
    this.coefficient = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    this.preDelaySamples = Math.max(0, Math.min(sampleRate, this.params.preDelay * sampleRate));
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;
    const inL = input?.[0];
    const inR = input?.[1] ?? inL;
    const depth = Math.max(0, Math.min(1, this.params.motion)) * 14;
    const lines = this.lines;
    const out = this.outputs;
    for (let n = 0; n < frames; n += 1) {
      const dry = inL ? (inL[n] + inR[n]) * 0.5 : 0;
      this.preDelay.push(dry);
      let x = this.preDelaySamples > 0 ? this.preDelay.read(this.preDelaySamples) : dry;
      for (const d of this.diffusers) {
        const delayed = d.line.readInt(d.length);
        const v = x + d.gain * delayed;
        d.line.push(v);
        x = delayed - d.gain * v;
      }
      let sum = 0;
      for (let i = 0; i < 8; i += 1) {
        let length = this.lengths[i];
        if (i % 2 === 0 && depth > 0) {
          const k = i >> 1;
          length += depth * Math.sin(this.phases[k]);
        }
        const raw = lines[i].read(length);
        this.damp[i] = raw + (this.damp[i] - raw) * this.coefficient;
        out[i] = this.damp[i] * this.gains[i];
        sum += out[i];
      }
      const householder = sum * 0.25; // 2 / N
      for (let i = 0; i < 8; i += 1) {
        lines[i].push(out[i] - householder + x * 0.35 + DENORMAL);
      }
      for (let k = 0; k < 4; k += 1) {
        this.phases[k] += (2 * Math.PI * this.rates[k]) / sampleRate;
        if (this.phases[k] > 2 * Math.PI) this.phases[k] -= 2 * Math.PI;
      }
      left[n] = (out[0] - out[1] + out[2] - out[3] + out[4] - out[5] + out[6] - out[7]) * 0.35;
      right[n] = (out[0] + out[1] - out[2] - out[3] + out[4] + out[5] - out[6] - out[7]) * 0.35;
    }
    return true;
  }
}

/**
 * Flanger with the feedback loop inside the delay line, so the sweep can go
 * down to a fraction of a millisecond (a Web Audio DelayNode inside a
 * feedback cycle is clamped to one 128-frame quantum, ~2.7 ms).
 */
class SonicFlangerProcessor extends BaseFx {
  constructor(options) {
    super();
    this.line = new DelayLine(powerOfTwoAtLeast(Math.ceil(sampleRate * 0.03)));
    this.phase = 0;
    this.params = { manual: 0.5, rate: 0.4, depth: 0.6, feedback: 0.4 };
    this.setParams(options.processorOptions ?? {});
  }

  setParams(params) {
    Object.assign(this.params, params);
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const source = input?.[0];
    const { manual, rate, depth, feedback } = this.params;
    // Electric-Mistress-like range: centre 0.3-7 ms, triangle sweep.
    const centre = (0.0003 + manual * manual * 0.0067) * sampleRate;
    const sweep = Math.min(centre - 2, centre * 0.95 * depth);
    const fb = Math.max(-0.95, Math.min(0.95, feedback));
    const step = rate / sampleRate;
    for (let n = 0; n < frames; n += 1) {
      const triangle = 1 - 4 * Math.abs(this.phase - 0.5);
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      const delay = Math.max(1, centre + sweep * triangle);
      const delayed = this.line.read(delay);
      const x = source ? source[n] : 0;
      this.line.push(x + fb * delayed + DENORMAL);
      output[0][n] = delayed;
    }
    for (let channel = 1; channel < output.length; channel += 1) output[channel].set(output[0]);
    return true;
  }
}

/**
 * Look-ahead true-peak limiter for the master bus. Inter-sample peaks are
 * estimated with 4x cubic interpolation; gain reduction starts one
 * look-ahead window early so the ceiling is held without clipping.
 */
class SonicLimiterProcessor extends BaseFx {
  constructor(options) {
    super();
    this.lookahead = Math.max(16, Math.round(sampleRate * 0.0013));
    this.channels = [0, 1].map(() => new DelayLine(powerOfTwoAtLeast(this.lookahead + 8)));
    this.targets = new Float32Array(this.lookahead);
    this.targetIndex = 0;
    this.gain = 1;
    this.history = [new Float32Array(4), new Float32Array(4)];
    this.params = { ceilingDb: -1, releaseMs: 80 };
    this.setParams(options.processorOptions ?? {});
  }

  setParams(params) {
    Object.assign(this.params, params);
    this.ceiling = Math.pow(10, this.params.ceilingDb / 20);
    this.release = Math.exp(-1 / (sampleRate * this.params.releaseMs / 1000));
    this.attack = Math.exp(-1 / (this.lookahead / 4));
  }

  peak(channel, value) {
    const h = this.history[channel];
    h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = value;
    let peak = Math.abs(h[2]);
    for (const t of [0.25, 0.5, 0.75]) {
      const c1 = 0.5 * (h[2] - h[0]);
      const c2 = h[0] - 2.5 * h[1] + 2 * h[2] - 0.5 * h[3];
      const c3 = 0.5 * (h[3] - h[0]) + 1.5 * (h[1] - h[2]);
      peak = Math.max(peak, Math.abs(((c3 * t + c2) * t + c1) * t + h[1]));
    }
    return peak;
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    for (let n = 0; n < frames; n += 1) {
      let peak = 0;
      for (let c = 0; c < 2; c += 1) {
        const x = input?.[c]?.[n] ?? input?.[0]?.[n] ?? 0;
        this.channels[c].push(x);
        peak = Math.max(peak, this.peak(c, x));
      }
      this.targets[this.targetIndex] = peak > this.ceiling ? this.ceiling / peak : 1;
      this.targetIndex = (this.targetIndex + 1) % this.lookahead;
      let target = 1;
      for (let i = 0; i < this.lookahead; i += 1) target = Math.min(target, this.targets[i]);
      this.gain = target < this.gain
        ? target + (this.gain - target) * this.attack
        : target + (this.gain - target) * this.release;
      for (let c = 0; c < output.length; c += 1) {
        const delayed = this.channels[Math.min(c, 1)].readInt(this.lookahead) * this.gain;
        // The envelope can lag a sudden peak by a sample: never exceed the ceiling.
        output[c][n] = Math.max(-this.ceiling, Math.min(this.ceiling, delayed));
      }
    }
    return true;
  }
}

registerProcessor('sonic-reverb', SonicReverbProcessor);
registerProcessor('sonic-flanger', SonicFlangerProcessor);
registerProcessor('sonic-limiter', SonicLimiterProcessor);
