import type { ControlSpec } from '../effects/catalog.ts';

export type AmpSpec = {
  id: string;
  name: string;
  family: string;
  description: string;
  modeling: string;
  finish: string;
  accent: string;
  controls: ControlSpec[];
  voicing: {
    drive: number;
    lowHz: number;
    midHz: number;
    highHz: number;
    presenceHz: number;
    highCut: number;
  };
};

export type CabSpec = {
  id: string;
  name: string;
  format: string;
  description: string;
  modeling: string;
  controls: ControlSpec[];
  voicing: {
    lowCut: number;
    highCut: number;
    bodyHz: number;
    bodyGain: number;
    airHz: number;
    airGain: number;
    impulseSeconds: number;
  };
};

export type AmpCabConfig = {
  ampId: string;
  cabId: string;
  ampValues: Record<string, number>;
  cabValues: Record<string, number>;
  bypassed: boolean;
};

const control = (id: string, label: string, defaultValue: number): ControlSpec => ({
  id, label, defaultValue, min: 0, max: 100, unit: '%', decimals: 0, curve: 'linear',
});

const ampControls = (defaults: [number, number, number, number, number, number, number]) => [
  control('input', '输入', defaults[0]),
  control('gain', '增益', defaults[1]),
  control('bass', '低频', defaults[2]),
  control('mid', '中频', defaults[3]),
  control('treble', '高频', defaults[4]),
  control('presence', '临场', defaults[5]),
  control('master', '主音量', defaults[6]),
];

const cabControls = () => [
  control('position', '麦克风位置', 48),
  control('distance', '距离', 18),
  control('room', '房间', 10),
];

export const AMP_SPECS: AmpSpec[] = [
  {
    id: 'glass-120', name: 'Roland JC-120 Jazz Chorus', family: '高余量晶体管清音', finish: '#30363b', accent: '#68bdd4',
    description: '参考 JC-120 的快速、平直和高余量清音；未建模其内置立体声合唱电路。', modeling: '算法近似·非官方·非采样/捕获',
    controls: ampControls([50, 18, 48, 52, 58, 56, 68]),
    voicing: { drive: 0.24, lowHz: 110, midHz: 780, highHz: 3_200, presenceHz: 5_200, highCut: 13_500 },
  },
  {
    id: 'american-twin', name: "Fender '65 Twin Reverb", family: '大功率美式清音', finish: '#ded8ca', accent: '#c82f2d',
    description: '参考 Twin Reverb 的宽低频、明亮上端和轻微中频凹陷；不包含真空管、变压器或弹簧混响模型。', modeling: '算法近似·非官方·非采样/捕获',
    controls: ampControls([52, 28, 56, 42, 62, 52, 66]),
    voicing: { drive: 0.52, lowHz: 95, midHz: 720, highHz: 3_000, presenceHz: 4_800, highCut: 12_500 },
  },
  {
    id: 'brit-20', name: 'Marshall DSL20HR', family: 'EL34 英式箱头', finish: '#171819', accent: '#e3b445',
    description: '参考 DSL20HR 的靠前中频、紧实低频和可叠加的前级颗粒；未逐级重建 DSL 电路。', modeling: '算法近似·非官方·非采样/捕获',
    controls: ampControls([50, 40, 52, 60, 54, 55, 64]),
    voicing: { drive: 0.92, lowHz: 105, midHz: 920, highHz: 3_200, presenceHz: 4_400, highCut: 10_800 },
  },
  {
    id: 'class-a-30', name: 'VOX AC30 Top Boost', family: 'EL84 英式亮音', finish: '#5b2f27', accent: '#d9b85e',
    description: '参考 AC30 Top Boost 的铃音高频、松软低中频和推动后的压缩感；未建模真实 EL84 功放。', modeling: '算法近似·非官方·非采样/捕获',
    controls: ampControls([48, 36, 48, 53, 64, 58, 62]),
    voicing: { drive: 0.78, lowHz: 120, midHz: 1_050, highHz: 3_600, presenceHz: 5_600, highCut: 12_000 },
  },
  {
    id: 'dark-stack', name: 'MESA/Boogie Dual Rectifier', family: '美式高增益堆栈', finish: '#25222a', accent: '#a56be2',
    description: '参考 Dual Rectifier 的密集饱和、厚低频和收敛上端；未建模多级前级、整流或功放响应。', modeling: '算法近似·非官方·非采样/捕获',
    controls: ampControls([46, 62, 58, 57, 48, 46, 58]),
    voicing: { drive: 1.42, lowHz: 92, midHz: 680, highHz: 2_800, presenceHz: 4_000, highCut: 9_200 },
  },
];

export const CAB_SPECS: CabSpec[] = [
  {
    id: 'open-1x12', name: "Fender '65 Deluxe Reverb 1×12 Jensen C12K", format: 'OPEN BACK', description: '参考开背 1×12 Jensen 箱体的轻、松和近场感。', modeling: '合成箱体·非实测 IR·非官方', controls: cabControls(),
    voicing: { lowCut: 78, highCut: 8_900, bodyHz: 175, bodyGain: 2.2, airHz: 3_600, airGain: 1.4, impulseSeconds: 0.024 },
  },
  {
    id: 'open-2x12', name: "Fender '65 Twin Reverb 2×12 Jensen C12K", format: 'OPEN BACK', description: '参考 Twin Reverb 开背 2×12 的宽松、饱满和明亮清音。', modeling: '合成箱体·非实测 IR·非官方', controls: cabControls(),
    voicing: { lowCut: 64, highCut: 8_500, bodyHz: 145, bodyGain: 2.8, airHz: 3_300, airGain: 1.2, impulseSeconds: 0.032 },
  },
  {
    id: 'blue-2x12', name: 'VOX AC30C2X 2×12 Celestion Alnico Blue', format: 'ALNICO', description: '参考 AC30C2X 蓝盆 2×12 的铃音上端和柔和压缩。', modeling: '合成箱体·非实测 IR·非官方', controls: cabControls(),
    voicing: { lowCut: 70, highCut: 9_600, bodyHz: 155, bodyGain: 2.1, airHz: 4_100, airGain: 2.4, impulseSeconds: 0.029 },
  },
  {
    id: 'closed-4x12', name: 'Marshall 1960A 4×12 Celestion G12T-75', format: 'CLOSED BACK', description: '参考 1960A 封闭 4×12 的紧低频、密集中低频和强推动感。', modeling: '合成箱体·非实测 IR·非官方', controls: cabControls(),
    voicing: { lowCut: 72, highCut: 7_600, bodyHz: 125, bodyGain: 4.2, airHz: 2_900, airGain: 1.1, impulseSeconds: 0.041 },
  },
  {
    id: 'direct', name: 'Direct / Full Range', format: 'FULL RANGE', description: '跳过扬声器染色，只保留箱头输出和轻微安全高切。', modeling: '直通滤波·无箱体建模', controls: cabControls(),
    voicing: { lowCut: 28, highCut: 16_000, bodyHz: 160, bodyGain: 0, airHz: 4_000, airGain: 0, impulseSeconds: 0 },
  },
];

const ampsById = new Map(AMP_SPECS.map((amp) => [amp.id, amp]));
const cabsById = new Map(CAB_SPECS.map((cab) => [cab.id, cab]));

export function getAmpSpec(id: string) {
  const amp = ampsById.get(id);
  if (!amp) throw new Error(`Unknown amp: ${id}`);
  return amp;
}

export function getCabSpec(id: string) {
  const cab = cabsById.get(id);
  if (!cab) throw new Error(`Unknown cabinet: ${id}`);
  return cab;
}

export function makeDefaultAmpValues(ampId: string) {
  return Object.fromEntries(getAmpSpec(ampId).controls.map((item) => [item.id, item.defaultValue]));
}

export function makeDefaultCabValues(cabId: string) {
  return Object.fromEntries(getCabSpec(cabId).controls.map((item) => [item.id, item.defaultValue]));
}

export function makeAmpCabConfig(
  ampId: string,
  cabId: string,
  ampValues: Record<string, number> = {},
  cabValues: Record<string, number> = {},
): AmpCabConfig {
  return {
    ampId,
    cabId,
    ampValues: { ...makeDefaultAmpValues(ampId), ...ampValues },
    cabValues: { ...makeDefaultCabValues(cabId), ...cabValues },
    bypassed: false,
  };
}

export function makeDefaultAmpCabConfig() {
  return makeAmpCabConfig('brit-20', 'closed-4x12');
}

export function validateAmpCatalog() {
  const errors: string[] = [];
  const ids = new Set<string>();
  [...AMP_SPECS, ...CAB_SPECS].forEach((spec) => {
    if (ids.has(spec.id)) errors.push(`duplicate model: ${spec.id}`);
    ids.add(spec.id);
    const controls = new Set<string>();
    spec.controls.forEach((entry) => {
      if (controls.has(entry.id)) errors.push(`duplicate control: ${spec.id}.${entry.id}`);
      controls.add(entry.id);
      if (entry.defaultValue < 0 || entry.defaultValue > 100) errors.push(`invalid default: ${spec.id}.${entry.id}`);
    });
  });
  return errors;
}
