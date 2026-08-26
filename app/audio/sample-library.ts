import { getSourceEvents, type SourceEvent } from './audio-core.ts';
import { type GuitarVoiceId, type SourceConfig } from './source-catalog.ts';

export type RealGuitarSample = {
  url: string;
  rootFrequency: number;
};

export type RealGuitarSampleBank = {
  instrument: string;
  source: string;
  sourceUrl: string;
  license: 'CC0 1.0';
  signal: 'raw-di';
  highCutHz: number;
  samples: RealGuitarSample[];
};

export type SamplePlaybackEvent = SourceEvent & {
  sample: RealGuitarSample;
  playbackRate: number;
};

export const SAMPLE_INPUT_PEAK = 10 ** (-15 / 20);

export function applySampleInputHeadroom(
  channels: Float32Array[],
  targetPeak = SAMPLE_INPUT_PEAK,
) {
  let peak = 0;
  channels.forEach((channel) => {
    for (let index = 0; index < channel.length; index += 1) {
      peak = Math.max(peak, Math.abs(channel[index]));
    }
  });
  if (peak <= targetPeak || peak === 0) return 1;
  const gain = targetPeak / peak;
  channels.forEach((channel) => {
    for (let index = 0; index < channel.length; index += 1) channel[index] *= gain;
  });
  return gain;
}

const directRoots = [
  ['c2', 65.406],
  ['f2', 87.307],
  ['a2', 110],
  ['c3', 130.813],
  ['d3', 146.832],
  ['g3', 195.998],
  ['b3', 246.942],
  ['cs4', 277.183],
  ['e4', 329.628],
  ['g4', 391.995],
  ['b4', 493.883],
  ['d5', 587.33],
] as const;

function samples(folder: string, roots: ReadonlyArray<readonly [string, number]>) {
  return roots.map(([name, rootFrequency]) => ({
    url: `/audio/guitars/${folder}/${name}.wav`,
    rootFrequency,
  }));
}

export const REAL_GUITAR_SAMPLE_BANKS: Record<GuitarVoiceId, RealGuitarSampleBank> = {
  'single-neck': {
    instrument: 'Fender electric guitar, bridge pickup, soft take',
    source: 'FreePats Electric Guitar Direct',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    signal: 'raw-di',
    highCutHz: 7_500,
    samples: samples('fender-direct-soft', directRoots),
  },
  'single-bridge': {
    instrument: 'Fender electric guitar, bridge pickup, balanced take',
    source: 'FreePats Electric Guitar Direct',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    signal: 'raw-di',
    highCutHz: 11_000,
    samples: samples('fender-direct-balanced', directRoots),
  },
  humbucker: {
    instrument: 'Fender electric guitar, bridge pickup, picked take',
    source: 'FreePats Electric Guitar Direct',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    signal: 'raw-di',
    highCutHz: 15_000,
    samples: samples('fender-direct-picked', directRoots),
  },
  hollowbody: {
    instrument: 'Fender electric guitar, bridge pickup, dark take',
    source: 'FreePats Electric Guitar Direct',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    signal: 'raw-di',
    highCutHz: 4_500,
    samples: samples('fender-direct-dark', directRoots),
  },
};

export function selectNearestSample(bank: RealGuitarSampleBank, frequency: number) {
  return bank.samples.reduce((nearest, candidate) => (
    Math.abs(Math.log2(frequency / candidate.rootFrequency))
      < Math.abs(Math.log2(frequency / nearest.rootFrequency))
      ? candidate
      : nearest
  ));
}

export function makeSamplePlaybackPlan(source: SourceConfig): SamplePlaybackEvent[] {
  const bank = REAL_GUITAR_SAMPLE_BANKS[source.guitar];
  return getSourceEvents(source).map((event) => {
    const sample = selectNearestSample(bank, event.frequency);
    return {
      ...event,
      sample,
      playbackRate: event.frequency / sample.rootFrequency,
    };
  });
}
