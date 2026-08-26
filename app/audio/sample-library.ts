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

const fenderRoots = [
  ['c2', 65.406],
  ['a2', 110],
  ['e3', 164.814],
  ['g3', 195.998],
  ['e4', 329.628],
  ['g4', 391.995],
  ['b4', 493.883],
] as const;

const blackAndGreenRoots = [
  ['e2', 82.407],
  ['a2', 110],
  ['d3', 146.832],
  ['g3', 195.998],
  ['c4', 261.626],
  ['g4', 391.995],
  ['c5', 523.251],
] as const;

function samples(folder: string, roots: ReadonlyArray<readonly [string, number]>) {
  return roots.map(([name, rootFrequency]) => ({
    url: `/audio/guitars/${folder}/${name}.m4a`,
    rootFrequency,
  }));
}

export const REAL_GUITAR_SAMPLE_BANKS: Record<GuitarVoiceId, RealGuitarSampleBank> = {
  'single-neck': {
    instrument: 'Gretsch Anniversary',
    source: 'Black & Green Guitars',
    sourceUrl: 'https://github.com/sfzinstruments/karoryfer.black-and-green-guitars',
    license: 'CC0 1.0',
    samples: samples('gretsch', blackAndGreenRoots),
  },
  'single-bridge': {
    instrument: 'Fender Stratocaster Bridge Clean',
    source: 'FreePats Clean Electric Guitar',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    samples: samples('fender-clean', fenderRoots),
  },
  humbucker: {
    instrument: 'Hofner Club',
    source: 'Black & Green Guitars',
    sourceUrl: 'https://github.com/sfzinstruments/karoryfer.black-and-green-guitars',
    license: 'CC0 1.0',
    samples: samples('hofner', blackAndGreenRoots),
  },
  hollowbody: {
    instrument: 'Fender Stratocaster Bridge Jazz',
    source: 'FreePats Clean Electric Guitar',
    sourceUrl: 'https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html',
    license: 'CC0 1.0',
    samples: samples('fender-jazz', fenderRoots),
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
