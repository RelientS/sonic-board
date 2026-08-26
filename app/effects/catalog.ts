import type { RoutingConfig, SignalLane, SourceKind } from '../audio/audio-core';
import { makeAmpCabConfig, type AmpCabConfig } from '../amps/catalog.ts';

export type EffectCategory = 'Dynamics' | 'Tone' | 'Drive' | 'Mod' | 'Delay' | 'Space';
export type ControlCurve = 'linear' | 'exponential';

export type ControlSpec = {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  unit: string;
  decimals?: number;
  curve?: ControlCurve;
};

export type EffectSpec = {
  id: string;
  name: string;
  maker: string;
  category: EffectCategory;
  family: string;
  description: string;
  finish: string;
  ink: string;
  accent: string;
  wide?: boolean;
  controls: ControlSpec[];
};

export type PresetChainItem = {
  specId: string;
  lane?: SignalLane;
  settings?: Record<string, number>;
};

export type FactoryPreset = {
  id: string;
  name: string;
  description: string;
  source: SourceKind;
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  chain: PresetChainItem[];
};

export type InstantiatedPreset = {
  chain: Array<{ instanceId: string; specId: string; lane?: SignalLane }>;
  values: Record<string, Record<string, number>>;
  bypassed: string[];
  source: SourceKind;
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
};

const c = (
  id: string,
  label: string,
  defaultValue: number,
  min = 0,
  max = 100,
  unit = '%',
  decimals = 0,
  curve: ControlCurve = 'linear',
): ControlSpec => ({ id, label, defaultValue, min, max, unit, decimals, curve });

const level = (id = 'level', label = '电平', defaultValue = 58) => c(id, label, defaultValue, -18, 12, 'dB', 1);
const mix = (defaultValue = 40) => c('mix', '混合', defaultValue);
const rate = (defaultValue = 25) => c('rate', '速率', defaultValue, 0.05, 10, 'Hz', 2, 'exponential');
const tone = (defaultValue = 50) => c('tone', '音色', defaultValue, 800, 12_000, 'Hz', 0, 'exponential');

export const EFFECT_SPECS: EffectSpec[] = [
  {
    id: 'studio-comp', name: '蓝盒压缩', maker: '动态研究所', category: 'Dynamics', family: '经典 VCA 压缩',
    description: '均衡拨弦动态，同时保留清音分解的颗粒感。', finish: '#3978b7', ink: '#f4f6f8', accent: '#ef5e47',
    controls: [level(), tone(52), c('attack', '起音', 58, 1, 80, 'ms', 0, 'exponential'), c('sustain', '延音', 46)],
  },
  {
    id: 'noise-gate', name: '静音门', maker: '动态研究所', category: 'Dynamics', family: '门限降噪',
    description: '收住多级高增益链的底噪，并控制音墙尾部。', finish: '#242629', ink: '#f2f1eb', accent: '#63c68d',
    controls: [c('threshold', '门限', 28, -72, -12, 'dB', 0), c('release', '释放', 42, 20, 1200, 'ms', 0, 'exponential'), level()],
  },
  {
    id: 'graphic-eq', name: '七段均衡', maker: '频谱工场', category: 'Tone', family: '吉他图示 EQ', wide: true,
    description: '七个吉他核心频段各 ±15 dB，补回法兹之后的中频。', finish: '#e6ddd0', ink: '#202124', accent: '#e95d3b',
    controls: [
      c('100', '100', 50, -15, 15, 'dB'), c('200', '200', 50, -15, 15, 'dB'), c('400', '400', 50, -15, 15, 'dB'),
      c('800', '800', 50, -15, 15, 'dB'), c('1600', '1.6K', 50, -15, 15, 'dB'), c('3200', '3.2K', 50, -15, 15, 'dB'),
      c('6400', '6.4K', 50, -15, 15, 'dB'), level('level', '总电平', 60),
    ],
  },
  {
    id: 'blue-drive', name: '蓝调驱动', maker: '城市电路', category: 'Drive', family: '动态过载',
    description: '低到中增益的前级推动，适合放在空间效果之前。', finish: '#2f66b1', ink: '#f7f4e9', accent: '#f04d37',
    controls: [level(), tone(54), c('gain', '增益', 38)],
  },
  {
    id: 'rodent-dist', name: '啮齿失真', maker: '地下电气', category: 'Drive', family: '硬削波失真',
    description: '失真到法兹之间的粗糙质感，反向滤波顺时针会削高频。', finish: '#242426', ink: '#f3f0df', accent: '#da3f34',
    controls: [c('distortion', '失真', 56), c('filter', '滤波', 45), level('volume', '音量', 62)],
  },
  {
    id: 'wall-fuzz', name: '音墙法兹', maker: '固态工坊', category: 'Drive', family: '三旋钮持续法兹', wide: true,
    description: '厚重延音与中频凹陷；加上中频和门限，方便在完整链路里落位。', finish: '#d5d0c1', ink: '#20201e', accent: '#ed4f34',
    controls: [level('volume', '音量', 58), tone(43), c('sustain', '延音', 67), c('mids', '中频', 54, -12, 12, 'dB', 1), c('attack', '起音', 22), c('gate', '门限', 8)],
  },
  {
    id: 'chainsaw-dist', name: '电锯失真', maker: '北境机器', category: 'Drive', family: '双频段高增益',
    description: '低频和高频同时推进的密集失真，适合更凶狠的噪音墙。', finish: '#d67b29', ink: '#25160d', accent: '#cb342c',
    controls: [level(), c('low', '低频', 72), c('high', '高频', 76), c('distortion', '失真', 78)],
  },
  {
    id: 'slow-phase', name: '慢速相位', maker: '轨道音频', category: 'Mod', family: '四级相位',
    description: '缓慢移动频谱凹口，让音墙内部流动。', finish: '#d57b29', ink: '#21150f', accent: '#542417',
    controls: [rate(18), c('depth', '深度', 38), c('res', '共振', 18), mix(44)],
  },
  {
    id: 'analog-chorus', name: '模拟合唱', maker: '湖面电子', category: 'Mod', family: 'BBD 合唱',
    description: '经典双旋钮合唱扩展了混合和高切，适合清音与法兹后。', finish: '#66a7b8', ink: '#10282e', accent: '#e14f3c',
    controls: [rate(30), c('depth', '深度', 48), mix(42), tone(55)],
  },
  {
    id: 'jet-flanger', name: '喷气镶边', maker: '轨道音频', category: 'Mod', family: '反馈镶边',
    description: '短延迟扫频与反馈，能从轻微漂移推到喷气式共振。', finish: '#7b5aa6', ink: '#f4eff8', accent: '#efd35e', wide: true,
    controls: [c('manual', '中心', 52), rate(24), c('depth', '深度', 62), c('res', '共振', 38), mix(46)],
  },
  {
    id: 'tape-vibrato', name: '磁带颤音', maker: '漂移装置', category: 'Mod', family: '纯音高颤音',
    description: '不混入干声的音高摆动，可模拟磁带漂移和摇把式起伏。', finish: '#7c82ad', ink: '#171a2e', accent: '#f1d65f',
    controls: [rate(20), c('depth', '深度', 24, 0, 50, 'cent'), c('rise', '渐入', 30, 0, 1000, 'ms', 0, 'exponential'), tone(48)],
  },
  {
    id: 'bias-tremolo', name: '偏压抖音', maker: '复古脉冲', category: 'Mod', family: '音量调制',
    description: '从圆滑正弦到硬切方波的周期音量变化。', finish: '#4f8c58', ink: '#f0f3e9', accent: '#edc75a',
    controls: [rate(34), c('depth', '深度', 48), c('wave', '波形', 35), level()],
  },
  {
    id: 'soft-detune', name: '轻微失谐', maker: '并行实验室', category: 'Mod', family: '三声部微移调',
    description: '固定的上下微移调，比合唱更稳，主要负责增厚和拓宽。', finish: '#cbded5', ink: '#173931', accent: '#ef6352',
    controls: [c('cents', '音分', 35, 0, 20, 'cent', 1), c('blend', '混合', 28), c('spread', '宽度', 54), tone(56)],
  },
  {
    id: 'analog-delay', name: '模拟延迟', maker: '暗桶电路', category: 'Delay', family: 'BBD 延迟',
    description: '高频逐次衰减的短到中时值延迟，容易融进乐句。', finish: '#a84236', ink: '#f6e8d4', accent: '#eeb84e', wide: true,
    controls: [c('time', '时间', 44, 40, 800, 'ms', 0, 'exponential'), c('feedback', '反馈', 32, 0, 88), mix(30), tone(34), c('mod', '漂移', 14)],
  },
  {
    id: 'tape-echo', name: '磁带回声', maker: '现场单元', category: 'Delay', family: '磁带多次回声',
    description: '带轻微走带漂移和高频磨损的重复回声。', finish: '#613126', ink: '#f2d4aa', accent: '#efb149', wide: true,
    controls: [c('time', '时间', 48, 60, 1200, 'ms', 0, 'exponential'), c('repeats', '反馈', 34, 0, 90), mix(27), c('wow', '晃动', 22), tone(38)],
  },
  {
    id: 'digital-delay', name: '数字延迟', maker: '精确回声', category: 'Delay', family: '清晰立体声延迟',
    description: '清晰重复、宽立体声与更长时值，适合节奏型声场。', finish: '#e7e7df', ink: '#1d2328', accent: '#ef5252', wide: true,
    controls: [c('time', '时间', 42, 40, 2000, 'ms', 0, 'exponential'), c('feedback', '反馈', 36, 0, 92), mix(34), tone(64), c('width', '宽度', 68)],
  },
  {
    id: 'reverse-space', name: '反向空间', maker: '夜航设备', category: 'Space', family: '反向门限混响', wide: true,
    description: '上升式反射包络；提供前延迟、高低切和密度控制。', finish: '#293c51', ink: '#f3efe4', accent: '#8be0d5',
    controls: [mix(42), c('decay', '混响时间', 58, 0.3, 12, 's', 1, 'exponential'), c('preDelay', '前延迟', 24, 0.1, 1000, 'ms', 0, 'exponential'), c('lowCut', '低切', 18, 32, 1000, 'Hz', 0, 'exponential'), c('highCut', '高切', 62, 1000, 11_000, 'Hz', 0, 'exponential'), c('density', '密度', 74)],
  },
  {
    id: 'gated-room', name: '门限空间', maker: '数字机架', category: 'Space', family: '八十年代门限混响', wide: true,
    description: '短促、密集、突然闭合的机架空间，适合放在失真之前。', finish: '#5d6268', ink: '#eff0ea', accent: '#f0b44a',
    controls: [mix(46), c('decay', '混响时间', 42, 0.3, 8, 's', 1, 'exponential'), c('hold', '保持', 38, 1, 3000, 'ms', 0, 'exponential'), c('release', '释放', 24, 5, 3000, 'ms', 0, 'exponential'), c('highCut', '高切', 48, 1000, 11_000, 'Hz', 0, 'exponential')],
  },
  {
    id: 'cloud-hall', name: '云端大厅', maker: '北岸音频', category: 'Space', family: '调制大厅混响', wide: true,
    description: '长尾大厅配轻微调制，放在链尾形成宽阔空气层。', finish: '#9688b8', ink: '#181323', accent: '#f3d778',
    controls: [mix(38), c('decay', '混响时间', 62, 0.5, 20, 's', 1, 'exponential'), c('preDelay', '前延迟', 18, 0, 500, 'ms', 0), tone(58), c('motion', '漂移', 31)],
  },
];

export const FACTORY_PRESETS: FactoryPreset[] = [
  {
    id: 'reverse-wall', name: '反向音墙', description: '反向空间先进法兹，厚、黏、带吸入感。', source: 'chords', output: 66,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('brit-20', 'closed-4x12', { gain: 32, mid: 64, presence: 52 }),
    chain: [
      { specId: 'studio-comp', settings: { sustain: 38, attack: 64 } },
      { specId: 'soft-detune', settings: { cents: 34, blend: 22, spread: 62 } },
      { specId: 'reverse-space', settings: { mix: 46, decay: 52, preDelay: 18, lowCut: 24, highCut: 58, density: 82 } },
      { specId: 'wall-fuzz', settings: { sustain: 76, tone: 48, mids: 63, gate: 10 } },
      { specId: 'graphic-eq', settings: { '100': 44, '200': 48, '400': 58, '800': 62, '1600': 59, '3200': 53, '6400': 45 } },
    ],
  },
  {
    id: 'soft-focus', name: '柔焦清音', description: '压缩、合唱、磁带回声和长大厅。', source: 'arpeggio', output: 72,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('glass-120', 'open-2x12', { gain: 14, treble: 61, presence: 58 }),
    chain: [
      { specId: 'studio-comp', settings: { sustain: 52, tone: 58 } },
      { specId: 'analog-chorus', settings: { rate: 24, depth: 38, mix: 38 } },
      { specId: 'tape-echo', settings: { time: 42, repeats: 28, mix: 24, wow: 18 } },
      { specId: 'cloud-hall', settings: { mix: 42, decay: 58, motion: 26 } },
    ],
  },
  {
    id: 'glide-bloom', name: '摇把花开', description: '缓慢颤音接反向空间，再由法兹焊成一体。', source: 'chords', output: 64,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('brit-20', 'closed-4x12', { gain: 28, mid: 61, treble: 51 }),
    chain: [
      { specId: 'tape-vibrato', settings: { rate: 16, depth: 34, rise: 18 } },
      { specId: 'blue-drive', settings: { gain: 42, tone: 57, level: 62 } },
      { specId: 'reverse-space', settings: { mix: 40, decay: 47, density: 78 } },
      { specId: 'wall-fuzz', settings: { sustain: 82, tone: 53, mids: 58 } },
      { specId: 'digital-delay', settings: { time: 34, feedback: 24, mix: 19, width: 72 } },
    ],
  },
  {
    id: 'grey-machine', name: '灰色机器', description: '啮齿失真推动电锯失真，门限空间迅速收尾。', source: 'lead', output: 58,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('dark-stack', 'closed-4x12', { gain: 46, bass: 54, presence: 42 }),
    chain: [
      { specId: 'noise-gate', settings: { threshold: 34, release: 28 } },
      { specId: 'rodent-dist', settings: { distortion: 48, filter: 58, volume: 56 } },
      { specId: 'chainsaw-dist', settings: { low: 74, high: 82, distortion: 72 } },
      { specId: 'graphic-eq', settings: { '100': 42, '400': 56, '800': 62, '1600': 64, '6400': 44 } },
      { specId: 'gated-room', settings: { mix: 29, decay: 32, hold: 26, release: 18 } },
    ],
  },
  {
    id: 'slow-orbit', name: '慢速轨道', description: '相位与失谐缓慢运动，延迟和大厅负责纵深。', source: 'arpeggio', output: 70,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('american-twin', 'open-2x12', { gain: 19, mid: 47, treble: 60 }),
    chain: [
      { specId: 'slow-phase', settings: { rate: 10, depth: 34, res: 16, mix: 36 } },
      { specId: 'soft-detune', settings: { cents: 28, blend: 24, spread: 76 } },
      { specId: 'analog-delay', settings: { time: 54, feedback: 32, mix: 26, mod: 12 } },
      { specId: 'cloud-hall', settings: { mix: 36, decay: 54, motion: 38 } },
    ],
  },
  {
    id: 'jet-cloud', name: '喷气云层', description: '轻过载后接深镶边，再铺磁带回声和大厅。', source: 'chords', output: 66,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('class-a-30', 'blue-2x12', { gain: 33, treble: 62, presence: 56 }),
    chain: [
      { specId: 'blue-drive', settings: { gain: 34, tone: 48, level: 64 } },
      { specId: 'jet-flanger', settings: { manual: 46, rate: 18, depth: 72, res: 54, mix: 44 } },
      { specId: 'tape-echo', settings: { time: 58, repeats: 42, mix: 28, wow: 31 } },
      { specId: 'cloud-hall', settings: { mix: 43, decay: 67, motion: 42 } },
    ],
  },
  {
    id: 'pulse-haze', name: '脉冲薄雾', description: '偏压抖音切出律动，反向空间和模拟延迟补足尾巴。', source: 'chords', output: 69,
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: makeAmpCabConfig('american-twin', 'open-2x12', { gain: 22, bass: 52, treble: 61 }),
    chain: [
      { specId: 'studio-comp', settings: { sustain: 44, attack: 52 } },
      { specId: 'bias-tremolo', settings: { rate: 39, depth: 52, wave: 28 } },
      { specId: 'reverse-space', settings: { mix: 31, decay: 39, preDelay: 14 } },
      { specId: 'analog-delay', settings: { time: 46, feedback: 28, mix: 25 } },
    ],
  },
  {
    id: 'stereo-bloom', name: '双路花开', description: 'A 路保持清晰与运动，B 路把反向空间压进法兹，左右展开。', source: 'chords', output: 63,
    routing: { mode: 'parallel', blend: 56, spread: 82 },
    amp: makeAmpCabConfig('glass-120', 'open-2x12', { gain: 17, mid: 55, treble: 59, presence: 57 }, { distance: 22, room: 15 }),
    chain: [
      { specId: 'studio-comp', lane: 'A', settings: { sustain: 40, attack: 58 } },
      { specId: 'analog-chorus', lane: 'A', settings: { rate: 21, depth: 43, mix: 38 } },
      { specId: 'digital-delay', lane: 'A', settings: { time: 36, feedback: 28, mix: 25, width: 76 } },
      { specId: 'reverse-space', lane: 'B', settings: { mix: 54, decay: 52, density: 80, highCut: 55 } },
      { specId: 'wall-fuzz', lane: 'B', settings: { sustain: 72, tone: 46, mids: 62, gate: 9 } },
      { specId: 'cloud-hall', lane: 'B', settings: { mix: 30, decay: 48, motion: 36 } },
    ],
  },
  {
    id: 'dual-wall', name: '双重音墙', description: '两种失真分别占据左右，中间由箱头和封闭 4×12 收束。', source: 'chords', output: 55,
    routing: { mode: 'parallel', blend: 50, spread: 68 },
    amp: makeAmpCabConfig('brit-20', 'closed-4x12', { gain: 24, bass: 50, mid: 66, presence: 48 }, { position: 56, distance: 14, room: 6 }),
    chain: [
      { specId: 'blue-drive', lane: 'A', settings: { gain: 36, tone: 54, level: 60 } },
      { specId: 'wall-fuzz', lane: 'A', settings: { sustain: 76, tone: 49, mids: 63, gate: 12 } },
      { specId: 'graphic-eq', lane: 'A', settings: { '400': 56, '800': 62, '1600': 58 } },
      { specId: 'rodent-dist', lane: 'B', settings: { distortion: 58, filter: 53, volume: 56 } },
      { specId: 'chainsaw-dist', lane: 'B', settings: { low: 69, high: 72, distortion: 66 } },
      { specId: 'gated-room', lane: 'B', settings: { mix: 26, decay: 29, hold: 24, release: 17 } },
    ],
  },
];

const byId = new Map(EFFECT_SPECS.map((effect) => [effect.id, effect]));
let presetSerial = 0;

export function getEffectSpec(id: string) {
  const effect = byId.get(id);
  if (!effect) throw new Error(`Unknown effect: ${id}`);
  return effect;
}

export function mapControlValue(control: ControlSpec, normalizedValue: number) {
  const normalized = Math.min(100, Math.max(0, normalizedValue)) / 100;
  const value = control.curve === 'exponential' && control.min > 0
    ? control.min * (control.max / control.min) ** normalized
    : control.min + (control.max - control.min) * normalized;
  return Number(value.toFixed(control.decimals ?? 0));
}

export function formatControlValue(control: ControlSpec, normalizedValue: number) {
  const value = mapControlValue(control, normalizedValue);
  const prefix = control.unit === 'dB' && value > 0 ? '+' : '';
  return `${prefix}${value} ${control.unit}`.trim();
}

export function validateCatalog(catalog: EffectSpec[]) {
  const errors: string[] = [];
  const effectIds = new Set<string>();
  catalog.forEach((effect) => {
    if (effectIds.has(effect.id)) errors.push(`duplicate effect: ${effect.id}`);
    effectIds.add(effect.id);
    if (effect.controls.length < 3) errors.push(`too few controls: ${effect.id}`);
    const controlIds = new Set<string>();
    effect.controls.forEach((control) => {
      if (controlIds.has(control.id)) errors.push(`duplicate control: ${effect.id}.${control.id}`);
      controlIds.add(control.id);
      if (control.defaultValue < 0 || control.defaultValue > 100) errors.push(`invalid default: ${effect.id}.${control.id}`);
      if (control.min >= control.max) errors.push(`invalid range: ${effect.id}.${control.id}`);
    });
  });
  return errors;
}

export function makeDefaultValues(specId: string) {
  return Object.fromEntries(getEffectSpec(specId).controls.map((control) => [control.id, control.defaultValue]));
}

export function instantiatePreset(preset: FactoryPreset): InstantiatedPreset {
  presetSerial += 1;
  const chain = preset.chain.map((item, index) => ({ instanceId: `${item.specId}-${presetSerial}-${index + 1}`, specId: item.specId, lane: item.lane ?? 'A' }));
  const values = Object.fromEntries(chain.map((item, index) => [
    item.instanceId,
    { ...makeDefaultValues(item.specId), ...preset.chain[index].settings },
  ]));
  return {
    chain,
    values,
    bypassed: [],
    source: preset.source,
    output: preset.output,
    routing: { ...preset.routing },
    amp: {
      ...preset.amp,
      ampValues: { ...preset.amp.ampValues },
      cabValues: { ...preset.amp.cabValues },
    },
  };
}
