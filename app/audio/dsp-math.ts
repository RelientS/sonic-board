/** Small DSP helpers used to design impulse responses in the browser. */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (sign * 2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Minimum-phase impulse response for a magnitude response sampled on
 * `n / 2 + 1` bins (DC..Nyquist), via the folded real cepstrum. Minimum phase
 * puts the energy at the start, like a real loudspeaker.
 */
export function minimumPhaseImpulse(magnitude: Float64Array, n: number) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k <= n / 2; k += 1) {
    const value = Math.log(Math.max(1e-9, magnitude[k]));
    re[k] = value;
    if (k > 0 && k < n / 2) re[n - k] = value;
  }
  fftInPlace(re, im, true);
  // Fold the cepstrum onto positive quefrencies.
  for (let i = 1; i < n / 2; i += 1) {
    re[i] *= 2;
    im[i] = 0;
  }
  for (let i = n / 2 + 1; i < n; i += 1) {
    re[i] = 0;
    im[i] = 0;
  }
  im[0] = 0;
  im[n / 2] = 0;
  fftInPlace(re, im, false);
  // exp() of the complex log spectrum.
  for (let k = 0; k < n; k += 1) {
    const amplitude = Math.exp(re[k]);
    const phase = im[k];
    re[k] = amplitude * Math.cos(phase);
    im[k] = amplitude * Math.sin(phase);
  }
  fftInPlace(re, im, true);
  return re;
}

/** |H| of a second-order section (RBJ cookbook shapes) at frequency f. */
function biquadMagnitude(
  type: 'lowpass' | 'highpass' | 'peaking',
  f: number,
  f0: number,
  q: number,
  gainDb = 0,
) {
  const x = f / f0;
  if (type === 'lowpass') return 1 / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2);
  if (type === 'highpass') return (x * x) / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2);
  const a = 10 ** (gainDb / 40);
  const num = (1 - x * x) ** 2 + (x * a / q) ** 2;
  const den = (1 - x * x) ** 2 + (x / (a * q)) ** 2;
  return Math.sqrt(num / den);
}

export type SpeakerVoicing = {
  /** Cone/cabinet resonance (Hz) and its Q: closed backs are peakier. */
  resonanceHz: number;
  resonanceQ: number;
  /** Extra first-order low cut for open-back cancellation (Hz, 0 = none). */
  openBackHz: number;
  bodyHz: number;
  bodyGain: number;
  presenceHz: number;
  presenceGain: number;
  /** Top-end roll-off corner (Hz). */
  highCut: number;
  /** Deterministic seed for the cone-breakup ripple. */
  seed: number;
};

export type MicPlacement = {
  /** 0 = on the dust cap (bright), 100 = edge of the cone (dark). */
  position: number;
  /** 0 = touching the grille (proximity bass), 100 = a foot away. */
  distance: number;
};

function lcg(seed: number) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Magnitude response of a miked guitar speaker, on `n / 2 + 1` bins. */
export function speakerMagnitude(voicing: SpeakerVoicing, mic: MicPlacement, sampleRate: number, n: number) {
  const bins = n / 2 + 1;
  const magnitude = new Float64Array(bins);
  const random = lcg(voicing.seed);
  // Cone breakup: a few narrow peaks and dips between 1.2 kHz and the corner.
  const ripples = Array.from({ length: 6 }, () => ({
    hz: 1_200 + random() * Math.max(800, voicing.highCut - 1_200),
    q: 4 + random() * 6,
    gain: (random() - 0.5) * 7,
  }));
  const position = Math.min(100, Math.max(0, mic.position));
  const distance = Math.min(100, Math.max(0, mic.distance));
  const corner = voicing.highCut * (1.18 - position / 240 - distance / 600);
  const proximityDb = 4 * (1 - distance / 100) ** 2;
  for (let k = 0; k < bins; k += 1) {
    const f = Math.max(1, (k * sampleRate) / n);
    let h = biquadMagnitude('highpass', f, voicing.resonanceHz, voicing.resonanceQ);
    if (voicing.openBackHz > 0) h *= f / Math.sqrt(f * f + voicing.openBackHz ** 2);
    h *= biquadMagnitude('peaking', f, voicing.bodyHz, 0.9, voicing.bodyGain);
    h *= biquadMagnitude('peaking', f, 150, 0.7, proximityDb);
    h *= biquadMagnitude('peaking', f, voicing.presenceHz, 1.1, voicing.presenceGain + (50 - position) * 0.06);
    for (const ripple of ripples) h *= biquadMagnitude('peaking', f, ripple.hz, ripple.q, ripple.gain);
    // Fourth-order roll-off with a slight peak at the corner, then a steeper
    // fall above it where the cone stops radiating coherently.
    h *= biquadMagnitude('lowpass', f, corner, 1.05) * biquadMagnitude('lowpass', f, corner * 1.12, 0.6);
    h *= biquadMagnitude('lowpass', f, corner * 1.9, 0.7);
    magnitude[k] = h;
  }
  // Normalize to unity at 1 kHz so cabinets differ in tone, not level.
  const reference = magnitude[Math.round((1_000 * n) / sampleRate)] || 1;
  for (let k = 0; k < bins; k += 1) magnitude[k] /= reference;
  return magnitude;
}
