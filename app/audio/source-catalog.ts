export type SourceKind = 'chords' | 'eighth-strum' | 'syncopated-strum' | 'wall-strum' | 'arpeggio' | 'lead';
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

export const PERFORMANCE_SPECS: Array<{ id: SourceKind; name: string; description: string }> = [
  { id: 'chords', name: '单次扫弦', description: '每个和弦向下一次，适合听音色本体。' },
  { id: 'eighth-strum', name: '八分扫弦', description: '连续下上交替，重拍更明确。' },
  { id: 'syncopated-strum', name: '切分扫弦', description: '保留空拍与反拍，律动更有推动感。' },
  { id: 'wall-strum', name: '慢速音墙', description: '稀疏长扫弦，给混响和法兹留空间。' },
  { id: 'arpeggio', name: '分解和弦', description: '逐音拨奏，适合检查延迟与尾音。' },
  { id: 'lead', name: '单音旋律', description: '固定旋律，适合检查延音和门限。' },
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

/**
 * A loop region inside the source, in seconds. `null` loops the whole
 * source. Regions shorter than MIN_LOOP_SECONDS are widened.
 */
export type LoopRegion = { start: number; end: number };
export const MIN_LOOP_SECONDS = 0.25;
export const INPUT_TRIM_RANGE_DB = 12;

/**
 * What feeds the board besides the example phrase (`source`): an optional
 * recorded or uploaded take (kept only in this browser; boards and presets
 * store its id), the loop region, and an input trim. A missing take falls
 * back to the example phrase.
 */
export type InputSettings = {
  takeId: string | null;
  loop: LoopRegion | null;
  trimDb: number;
};

export const DEFAULT_INPUT_SETTINGS: InputSettings = { takeId: null, loop: null, trimDb: 0 };

/** The source the engine actually plays. */
export type PlaybackSource =
  | { kind: 'example'; config: SourceConfig }
  | { kind: 'take'; takeId: string };

export function clampTrimDb(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(-INPUT_TRIM_RANGE_DB, Math.min(INPUT_TRIM_RANGE_DB, value)) * 10) / 10;
}

export function trimDbToGain(value: number) {
  return 10 ** (clampTrimDb(value) / 20);
}

function normalizeLoopShape(value: unknown): LoopRegion | null {
  if (!value || typeof value !== 'object') return null;
  const { start, end } = value as Partial<LoopRegion>;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end - start <= 0) return null;
  return { start: Math.max(0, start), end };
}

export function normalizeInputSettings(value: unknown): InputSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_INPUT_SETTINGS };
  const candidate = value as Partial<Record<keyof InputSettings, unknown>>;
  const takeId = typeof candidate.takeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(candidate.takeId) ? candidate.takeId : null;
  return {
    takeId,
    loop: normalizeLoopShape(candidate.loop),
    trimDb: typeof candidate.trimDb === 'number' ? clampTrimDb(candidate.trimDb) : 0,
  };
}

/**
 * The loop actually played for a source of `duration` seconds: clamped into
 * the source and at least MIN_LOOP_SECONDS long (or the whole source when it
 * is shorter than that).
 */
export function effectiveLoop(loop: LoopRegion | null, duration: number): LoopRegion {
  if (!(duration > 0)) return { start: 0, end: 0 };
  if (!loop || duration <= MIN_LOOP_SECONDS) return { start: 0, end: duration };
  let start = Math.min(Math.max(0, loop.start), duration - MIN_LOOP_SECONDS);
  let end = Math.min(duration, Math.max(loop.end, start + MIN_LOOP_SECONDS));
  if (end - start < MIN_LOOP_SECONDS) start = Math.max(0, end - MIN_LOOP_SECONDS);
  start = Math.round(start * 1000) / 1000;
  end = Math.round(end * 1000) / 1000;
  return start <= 0 && end >= duration ? { start: 0, end: duration } : { start, end };
}

/** Where the playhead sits `elapsed` seconds after it entered the loop at its start. */
export function loopPosition(loop: LoopRegion, elapsed: number) {
  const length = loop.end - loop.start;
  if (!(length > 0) || !Number.isFinite(elapsed)) return loop.start;
  return loop.start + (((elapsed % length) + length) % length);
}

/** Maps an absolute playhead position into `loop` (positions outside wrap to its start). */
export function positionInLoop(loop: LoopRegion, position: number) {
  if (position >= loop.start && position < loop.end) return position;
  return loop.start;
}

/** The loop edited by dragging one handle or the whole region by `delta` seconds. */
export function dragLoop(loop: LoopRegion, part: 'start' | 'end' | 'region', delta: number, duration: number): LoopRegion {
  if (part === 'region') {
    const length = loop.end - loop.start;
    const start = Math.min(Math.max(0, loop.start + delta), Math.max(0, duration - length));
    return effectiveLoop({ start, end: start + length }, duration);
  }
  if (part === 'start') {
    return effectiveLoop({ start: Math.min(loop.start + delta, loop.end - MIN_LOOP_SECONDS), end: loop.end }, duration);
  }
  return effectiveLoop({ start: loop.start, end: Math.max(loop.end + delta, loop.start + MIN_LOOP_SECONDS) }, duration);
}

/**
 * Level guidance for the input meter. A passive single coil peaks around
 * −18…−10 dBFS on a typical interface at unity gain, a hot humbucker up to
 * −6; the pedal models are calibrated for roughly that range.
 */
export const INPUT_LEVEL_TARGET = { lowDbfs: -24, highDbfs: -4 } as const;

export function inputLevelVerdict(peakDbfs: number): '偏小' | '合适' | '偏大' | null {
  if (!Number.isFinite(peakDbfs) || peakDbfs < -80) return null;
  if (peakDbfs < INPUT_LEVEL_TARGET.lowDbfs) return '偏小';
  if (peakDbfs > INPUT_LEVEL_TARGET.highDbfs) return '偏大';
  return '合适';
}

export function formatSeconds(value: number) {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
