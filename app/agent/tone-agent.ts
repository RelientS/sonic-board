import { makeAmpCabConfig } from '../amps/catalog.ts';
import {
  getGuitarVoice,
  getPerformanceSpec,
  makeSourceConfig,
  type ChordProgressionId,
  type GuitarVoiceId,
  type SourceKind,
} from '../audio/source-catalog.ts';
import type { FactoryPreset, PresetChainItem } from '../effects/catalog.ts';

export type ToneAgentPlan = {
  name: string;
  summary: string;
  decisions: string[];
  preset: FactoryPreset & { source: ReturnType<typeof makeSourceConfig> };
};

const has = (text: string, expression: RegExp) => expression.test(text);

function inferSource(text: string, character: 'wall' | 'clean' | 'noise' | 'vintage' | 'motion') {
  const performance: SourceKind = has(text, /分解|琶音|arpeggio/) ? 'arpeggio'
    : has(text, /单音|旋律|lead/) ? 'lead'
      : has(text, /切分|反拍|syncop/) ? 'syncopated-strum'
        : has(text, /八分|直八|连续扫弦|eighth/) ? 'eighth-strum'
          : has(text, /慢速扫弦|慢扫|稀疏扫弦/) ? 'wall-strum'
            : 'chords';
  const guitar: GuitarVoiceId = has(text, /明亮|清晰|琴桥|bright/) ? 'single-bridge'
    : has(text, /温暖|柔和|爵士|空心|复古|warm|jazz/) ? 'hollowbody'
      : has(text, /厚|重|音墙|法兹|凶|双线圈|humbucker|fuzz/) || character === 'noise' || character === 'wall' ? 'humbucker'
        : 'single-neck';
  const progression: ChordProgressionId = has(text, /小调|阴暗|忧郁|minor/) ? 'minor-drift'
    : has(text, /五度|强力|power/) || character === 'noise' ? 'power-bloom'
      : has(text, /大七|清光|明亮|major/) || character === 'clean' ? 'major-seven'
        : 'dream-open';
  return makeSourceConfig(performance, guitar, progression);
}

function makeWallChain(wide: boolean): PresetChainItem[] {
  if (wide) {
    return [
      { specId: 'studio-comp', lane: 'A', settings: { sustain: 42, attack: 61, tone: 56 } },
      { specId: 'analog-chorus', lane: 'A', settings: { rate: 21, depth: 38, mix: 34, tone: 57 } },
      { specId: 'digital-delay', lane: 'A', settings: { time: 35, feedback: 27, mix: 23, tone: 62, width: 78 } },
      { specId: 'reverse-space', lane: 'B', settings: { mix: 54, decay: 55, preDelay: 15, lowCut: 24, highCut: 57, density: 84 } },
      { specId: 'wall-fuzz', lane: 'B', settings: { volume: 57, tone: 48, sustain: 76, mids: 66, attack: 20, gate: 10 } },
      { specId: 'graphic-eq', lane: 'B', settings: { '100': 43, '200': 49, '400': 58, '800': 64, '1600': 62, '3200': 53, '6400': 45, level: 57 } },
      { specId: 'cloud-hall', lane: 'B', settings: { mix: 31, decay: 50, preDelay: 18, tone: 55, motion: 33 } },
    ];
  }
  return [
    { specId: 'studio-comp', settings: { sustain: 40, attack: 62, tone: 55 } },
    { specId: 'soft-detune', settings: { cents: 34, blend: 24, spread: 66, tone: 55 } },
    { specId: 'reverse-space', settings: { mix: 47, decay: 53, preDelay: 17, lowCut: 24, highCut: 58, density: 82 } },
    { specId: 'wall-fuzz', settings: { volume: 58, tone: 48, sustain: 77, mids: 65, attack: 21, gate: 10 } },
    { specId: 'graphic-eq', settings: { '100': 43, '200': 49, '400': 58, '800': 64, '1600': 61, '3200': 53, '6400': 45, level: 58 } },
  ];
}

function makeCleanChain(wide: boolean): PresetChainItem[] {
  const chain: PresetChainItem[] = [
    { specId: 'studio-comp', lane: 'A', settings: { sustain: 52, attack: 56, tone: 61, level: 59 } },
    { specId: 'analog-chorus', lane: wide ? 'A' : undefined, settings: { rate: 23, depth: 41, mix: 36, tone: 59 } },
    { specId: 'tape-echo', lane: wide ? 'B' : undefined, settings: { time: 43, repeats: 29, mix: 25, wow: 19, tone: 42 } },
    { specId: 'cloud-hall', lane: wide ? 'B' : undefined, settings: { mix: 41, decay: 60, preDelay: 20, tone: 61, motion: 28 } },
  ];
  if (wide) chain.splice(2, 0, { specId: 'soft-detune', lane: 'A', settings: { cents: 29, blend: 22, spread: 78, tone: 61 } });
  return chain;
}

function makeNoiseChain(): PresetChainItem[] {
  return [
    { specId: 'noise-gate', settings: { threshold: 38, release: 24, level: 56 } },
    { specId: 'rodent-dist', settings: { distortion: 57, filter: 54, volume: 56 } },
    { specId: 'chainsaw-dist', settings: { level: 54, low: 71, high: 79, distortion: 75 } },
    { specId: 'graphic-eq', settings: { '100': 42, '200': 47, '400': 58, '800': 64, '1600': 65, '3200': 54, '6400': 42, level: 55 } },
    { specId: 'gated-room', settings: { mix: 31, decay: 34, hold: 23, release: 17, highCut: 44 } },
  ];
}

function makeVintageChain(): PresetChainItem[] {
  return [
    { specId: 'studio-comp', settings: { sustain: 46, attack: 51, tone: 45, level: 58 } },
    { specId: 'slow-phase', settings: { rate: 13, depth: 34, res: 17, mix: 34 } },
    { specId: 'tape-vibrato', settings: { rate: 18, depth: 26, rise: 28, tone: 43 } },
    { specId: 'tape-echo', settings: { time: 51, repeats: 37, mix: 28, wow: 31, tone: 34 } },
    { specId: 'cloud-hall', settings: { mix: 34, decay: 49, preDelay: 15, tone: 46, motion: 35 } },
  ];
}

function makeMotionChain(wide: boolean): PresetChainItem[] {
  return [
    { specId: 'studio-comp', lane: 'A', settings: { sustain: 43, attack: 57, tone: 56, level: 58 } },
    { specId: 'slow-phase', lane: 'A', settings: { rate: 11, depth: 39, res: 18, mix: 37 } },
    { specId: 'soft-detune', lane: wide ? 'B' : undefined, settings: { cents: 30, blend: 25, spread: 77, tone: 57 } },
    { specId: 'analog-delay', lane: wide ? 'B' : undefined, settings: { time: 52, feedback: 31, mix: 27, tone: 39, mod: 15 } },
    { specId: 'cloud-hall', lane: wide ? 'B' : undefined, settings: { mix: 37, decay: 56, preDelay: 18, tone: 57, motion: 40 } },
  ];
}

export function planToneRequest(input: string): ToneAgentPlan {
  const text = input.trim().toLowerCase();
  const wide = has(text, /立体声|宽阔|很宽|左右|并联|双声道|stereo|wide/);
  const noise = has(text, /很凶|凶狠|噪音|工业|电锯|快速收尾|noise/);
  const wall = !noise && (text.length === 0 || has(text, /音墙|法兹|厚重|反向|吸入|mbv|fuzz/));
  const vintage = !noise && !wall && has(text, /复古|磁带感|老式|lo.?fi|warm|温暖/);
  const motion = !noise && !wall && !vintage && has(text, /流动|相位|旋转|漂移|运动|phase/);
  const character = noise ? 'noise' : wall ? 'wall' : vintage ? 'vintage' : motion ? 'motion' : 'clean';
  const source = inferSource(text, character);
  const routing = wide ? { mode: 'parallel' as const, blend: 54, spread: 82 } : { mode: 'serial' as const, blend: 50, spread: 0 };

  const config = character === 'noise' ? {
    name: '门限噪音机器', summary: '高增益双失真配中频修正，并用门限空间迅速收尾。', chain: makeNoiseChain(),
    amp: makeAmpCabConfig('dark-stack', 'closed-4x12', { gain: 44, bass: 53, mid: 61, treble: 51, presence: 43, master: 64 }), output: 57,
  } : character === 'wall' ? {
    name: wide ? '立体反向音墙' : '反向音墙', summary: '反向空间先进法兹，中频由图示均衡补回，避免只剩低频轰鸣。', chain: makeWallChain(wide),
    amp: makeAmpCabConfig('brit-20', 'closed-4x12', { gain: 29, bass: 49, mid: 66, treble: 52, presence: 49, master: 65 }), output: 63,
  } : character === 'vintage' ? {
    name: '复古漂移', summary: '慢相位、轻颤音和磁带回声形成温暖的不稳定感。', chain: makeVintageChain(),
    amp: makeAmpCabConfig('class-a-30', 'blue-2x12', { gain: 24, bass: 49, mid: 57, treble: 52, presence: 45, master: 68 }), output: 68,
  } : character === 'motion' ? {
    name: '慢速轨道', summary: '相位和微失谐负责移动，模拟延迟与大厅负责纵深。', chain: makeMotionChain(wide),
    amp: makeAmpCabConfig('american-twin', 'open-2x12', { gain: 18, bass: 49, mid: 51, treble: 60, presence: 56, master: 70 }), output: 70,
  } : {
    name: wide ? '立体柔焦清音' : '柔焦清音', summary: '压缩保留颗粒，合唱、磁带回声和长大厅逐层扩散。', chain: makeCleanChain(wide),
    amp: makeAmpCabConfig('glass-120', 'open-2x12', { gain: 14, bass: 48, mid: 54, treble: 62, presence: 59, master: 72 }), output: 72,
  };

  const decisions = [
    wide ? '使用双路并联，并把空间与动态分到左右通道。' : '保持串联，让各级效果按顺序彼此推动。',
    `清音输入选择 ${getGuitarVoice(source.guitar).name} 真实采样。`,
    `使用${getPerformanceSpec(source.performance).name}检查效果器对演奏动态的响应。`,
  ];

  return {
    name: config.name,
    summary: config.summary,
    decisions,
    preset: {
      id: 'agent-plan',
      name: config.name,
      description: config.summary,
      source,
      output: config.output,
      routing,
      amp: config.amp,
      chain: config.chain,
    },
  };
}
