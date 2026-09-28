/**
 * Min/max peaks of a signal in `buckets` columns, for drawing a waveform.
 * Computed once per (signal, bucket count) and cached.
 */
export type WaveformPeaks = { min: Float32Array; max: Float32Array; duration: number };

const peakCache = new WeakMap<Float32Array, Map<number, WaveformPeaks>>();

export function computePeaks(signal: Float32Array, sampleRate: number, buckets: number): WaveformPeaks {
  const count = Math.max(1, Math.floor(buckets));
  let byCount = peakCache.get(signal);
  const cached = byCount?.get(count);
  if (cached) return cached;
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const step = signal.length / count;
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor(bucket * step);
    const to = Math.max(from + 1, Math.floor((bucket + 1) * step));
    let low = 0;
    let high = 0;
    for (let i = from; i < to && i < signal.length; i += 1) {
      const value = signal[i];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bucket] = low;
    max[bucket] = high;
  }
  const peaks = { min, max, duration: sampleRate > 0 ? signal.length / sampleRate : 0 };
  if (!byCount) {
    byCount = new Map();
    peakCache.set(signal, byCount);
  }
  byCount.set(count, peaks);
  return peaks;
}

/** Peak (not RMS) of a block, as dBFS; -Infinity for silence. */
export function peakDbfs(block: Float32Array) {
  let peak = 0;
  for (let i = 0; i < block.length; i += 1) {
    const value = Math.abs(block[i]);
    if (value > peak) peak = value;
  }
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/** Largest absolute sample, for scaling a waveform so quiet DI is still visible. */
export function peakScale(peaks: WaveformPeaks) {
  let peak = 0;
  for (let i = 0; i < peaks.max.length; i += 1) peak = Math.max(peak, peaks.max[i], -peaks.min[i]);
  return peak > 0 ? Math.min(8, 0.95 / peak) : 1;
}
