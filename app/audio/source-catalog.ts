export type SourceKind = 'chords' | 'arpeggio' | 'lead';
export type GuitarVoiceId = 'single-neck' | 'single-bridge' | 'humbucker' | 'hollowbody';
export type ChordProgressionId = 'dream-open' | 'minor-drift' | 'major-seven' | 'power-bloom';

export type SourceConfig = {
  guitar: GuitarVoiceId;
  performance: SourceKind;
  progression: ChordProgressionId;
};

export const GUITAR_VOICES: Array<{ id: GuitarVoiceId; name: string; description: string }> = [
  { id: 'single-neck', name: 'Fender DI Soft', description: '真实采样，未处理 DI，拨弦柔和，适合合唱和长混响。' },
  { id: 'single-bridge', name: 'Fender DI Balanced', description: '真实采样，未处理 DI，频响均衡，适合搭建通用音色。' },
  { id: 'humbucker', name: 'Fender DI Picked', description: '真实采样，未处理 DI，起音明确，适合推动失真和法兹。' },
  { id: 'hollowbody', name: 'Fender DI Dark', description: '真实采样，未处理 DI，高频收敛，适合复古和柔和清音。' },
];

export const PERFORMANCE_SPECS: Array<{ id: SourceKind; name: string }> = [
  { id: 'chords', name: '扫弦和弦' },
  { id: 'arpeggio', name: '分解和弦' },
  { id: 'lead', name: '单音旋律' },
];

export const CHORD_PROGRESSIONS: Array<{
  id: ChordProgressionId;
  name: string;
  chords: string;
  frequencies: number[][];
}> = [
  {
    id: 'dream-open', name: '开放梦境', chords: 'Aadd9 · Fmaj7 · Cmaj7 · G6',
    frequencies: [
      [110, 164.81, 220, 246.94],
      [87.31, 130.81, 164.81, 220],
      [130.81, 196, 246.94, 329.63],
      [98, 146.83, 164.81, 246.94],
    ],
  },
  {
    id: 'minor-drift', name: '小调漂移', chords: 'Em9 · Cmaj7 · G6 · Dsus2',
    frequencies: [
      [82.41, 123.47, 146.83, 196],
      [130.81, 164.81, 196, 246.94],
      [98, 146.83, 164.81, 246.94],
      [146.83, 220, 246.94, 293.66],
    ],
  },
  {
    id: 'major-seven', name: '大七清光', chords: 'Cmaj7 · Am7 · Fmaj7 · G6',
    frequencies: [
      [130.81, 164.81, 196, 246.94],
      [110, 130.81, 164.81, 196],
      [87.31, 130.81, 164.81, 220],
      [98, 146.83, 164.81, 246.94],
    ],
  },
  {
    id: 'power-bloom', name: '五度音墙', chords: 'E5 · G5 · D5 · A5',
    frequencies: [
      [82.41, 123.47, 164.81],
      [98, 146.83, 196],
      [73.42, 110, 146.83],
      [110, 164.81, 220],
    ],
  },
];

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  guitar: 'single-neck',
  performance: 'chords',
  progression: 'dream-open',
};

export function makeSourceConfig(
  performance: SourceKind = DEFAULT_SOURCE_CONFIG.performance,
  guitar: GuitarVoiceId = DEFAULT_SOURCE_CONFIG.guitar,
  progression: ChordProgressionId = DEFAULT_SOURCE_CONFIG.progression,
): SourceConfig {
  return { guitar, performance, progression };
}

export function normalizeSourceConfig(value: unknown): SourceConfig {
  if (typeof value === 'string') {
    const performance = PERFORMANCE_SPECS.some((entry) => entry.id === value) ? value as SourceKind : DEFAULT_SOURCE_CONFIG.performance;
    return { ...DEFAULT_SOURCE_CONFIG, performance };
  }
  if (!value || typeof value !== 'object') return { ...DEFAULT_SOURCE_CONFIG };
  const candidate = value as Partial<SourceConfig>;
  return {
    guitar: GUITAR_VOICES.some((entry) => entry.id === candidate.guitar) ? candidate.guitar! : DEFAULT_SOURCE_CONFIG.guitar,
    performance: PERFORMANCE_SPECS.some((entry) => entry.id === candidate.performance) ? candidate.performance! : DEFAULT_SOURCE_CONFIG.performance,
    progression: CHORD_PROGRESSIONS.some((entry) => entry.id === candidate.progression) ? candidate.progression! : DEFAULT_SOURCE_CONFIG.progression,
  };
}

export function sourceConfigKey(value: SourceConfig) {
  return `${value.guitar}:${value.performance}:${value.progression}`;
}

export function getGuitarVoice(id: GuitarVoiceId) {
  return GUITAR_VOICES.find((entry) => entry.id === id) ?? GUITAR_VOICES[0];
}

export function getPerformanceSpec(id: SourceKind) {
  return PERFORMANCE_SPECS.find((entry) => entry.id === id) ?? PERFORMANCE_SPECS[0];
}

export function getChordProgression(id: ChordProgressionId) {
  return CHORD_PROGRESSIONS.find((entry) => entry.id === id) ?? CHORD_PROGRESSIONS[0];
}

export function formatSourceConfig(value: SourceConfig) {
  const guitar = getGuitarVoice(value.guitar).name;
  const performance = getPerformanceSpec(value.performance).name;
  return `${guitar} · ${performance}`;
}
