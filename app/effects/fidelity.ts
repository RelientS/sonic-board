export type EffectFidelityEngine =
  | 'PedalKernel WDF + calibrated corrections'
  | 'PedalKernel realtime correction'
  | 'Web Audio BBD approximation';

export type PedalKernelFidelityProfile = {
  engine: EffectFidelityEngine;
  upstreamCommit: string;
  upstreamModel: string;
  targetScore: number;
  verifiedScore: number | null;
  evidence: Array<'upstream-circuit' | 'runtime-regression' | 'hardware-abx'>;
  runtime: 'pedalkernel' | 'web-audio';
  status: 'candidate' | 'fallback';
  note: string;
};

// Pedals solved from a traced schematic by the Sonic Board DK circuit engine.
// `spiceNrmsePercent` is the worst normalized RMS error against ngspice over
// the model's validation matrix (knob extremes x test signals); it measures
// solver fidelity to the schematic, not closeness to a physical unit.
export type CircuitFidelityProfile = {
  engine: 'SPICE netlist + DK circuit solver';
  runtime: 'circuit';
  netlist: string;
  schematic: string;
  spiceNrmsePercent: number;
  oversample: number;
  targetScore: number;
  verifiedScore: number | null;
  evidence: Array<'traced-schematic' | 'spice-reference' | 'runtime-regression' | 'hardware-abx'>;
  status: 'candidate';
  note: string;
};

export type EffectFidelityProfile = PedalKernelFidelityProfile | CircuitFidelityProfile;

const circuitProfile = (
  netlist: string,
  schematic: string,
  spiceNrmsePercent: number,
  oversample: number,
): CircuitFidelityProfile => ({
  engine: 'SPICE netlist + DK circuit solver',
  runtime: 'circuit',
  netlist,
  schematic,
  spiceNrmsePercent,
  oversample,
  targetScore: 8,
  verifiedScore: null,
  evidence: ['traced-schematic', 'spice-reference', 'runtime-regression'],
  status: 'candidate',
  note: '按原理图逐元件实时求解，并与 ngspice 同网表仿真对齐；尚未与真机录音做 ABX，因此不给还原分。',
});

const PEDALKERNEL_COMMIT = '0278b397c861b5ebef2e8e38d15ab281b8e669dc';

const fidelityProfile = (
  upstreamModel: string,
  engine: EffectFidelityEngine = 'PedalKernel WDF + calibrated corrections',
): PedalKernelFidelityProfile => ({
  engine,
  upstreamCommit: PEDALKERNEL_COMMIT,
  upstreamModel,
  targetScore: 8,
  verifiedScore: null,
  evidence: ['upstream-circuit', 'runtime-regression'],
  runtime: 'pedalkernel',
  status: 'candidate',
  note: engine === 'PedalKernel realtime correction'
    ? '浏览器使用实时修正路径而非完整 WDF 求解；持续输出、有限值、输出校准和控制响应门禁已通过，仍需与真实硬件盲测后才能给出还原分。'
    : '持续输出、有限值、输出校准和控制响应门禁已通过；仍需与真实硬件盲测后才能给出还原分。',
});

const bbdFallbackProfile = (upstreamModel: string): PedalKernelFidelityProfile => ({
  engine: 'Web Audio BBD approximation',
  upstreamCommit: PEDALKERNEL_COMMIT,
  upstreamModel,
  targetScore: 8,
  verifiedScore: null,
  evidence: ['runtime-regression'],
  runtime: 'web-audio',
  status: 'fallback',
  note: '上游 BBD 电路在静音输入下仍会输出噪声，且没有形成正确的延迟重复；浏览器暂用稳定的 Web Audio 延迟、反馈、低通衰减和慢速调制近似。',
});

export const EFFECT_FIDELITY_PROFILES: Record<string, EffectFidelityProfile> = {
  'studio-comp': fidelityProfile('examples/pedals/compressor/dyna_comp.pedal'),
  'blue-drive': circuitProfile(
    'dsp/circuit/models/boss_bd2.cir',
    'Boss BD-2 MT board assy 70567645 service schematic; cross-checked with gaussmarkov and Aion FX Sapphire',
    1.12,
    2,
  ),
  'rodent-dist': circuitProfile(
    'dsp/circuit/models/proco_rat2.cir',
    'Beavis Audio ProCo RAT II schematic; cross-checked with ElectroSmash and tagboardeffects',
    0.29,
    4,
  ),
  'wall-fuzz': circuitProfile(
    'dsp/circuit/models/rams_head_muff.cir',
    "Kit Rae, Version 2 Big Muff Violet 1st Version (1973 #4), bigmuffpage.com",
    0.52,
    4,
  ),
  'dm2-delay': bbdFallbackProfile('examples/pedals/delay/boss_dm2.pedal'),
  'analog-delay': bbdFallbackProfile('examples/pedals/delay/memory_man.pedal'),
  'fuzz-face': circuitProfile(
    'dsp/circuit/models/fuzz_face.cir',
    'ElectroSmash Fuzz Face analysis (AC128 germanium, positive ground); R.G. Keen, Technology of the Fuzz Face',
    0.13,
    4,
  ),
  'analog-chorus': fidelityProfile('examples/pedals/modulation/boss_ce2.pedal'),
  'ocd-drive': circuitProfile(
    'dsp/circuit/models/fulltone_ocd.cir',
    'PCB Guitar Mania TOC v2.1 docs (tuemmueh trace, OCD version 3); cross-checked with Sabrotone and analogisnotdead',
    0.08,
    4,
  ),
  'klon-centaur': circuitProfile(
    'dsp/circuit/models/klon_centaur.cir',
    'ElectroSmash Klon Centaur analysis schematic; cross-checked with Aion FX Refractor',
    0.05,
    2,
  ),
  'sd1-drive': circuitProfile(
    'dsp/circuit/models/boss_sd1.cir',
    'Boss SD-1 service schematic (hobby-hour / schematicheaven)',
    0.06,
    4,
  ),
  'tube-screamer': circuitProfile(
    'dsp/circuit/models/ibanez_ts808.cir',
    'ElectroSmash Tube Screamer analysis (full TS808 schematic); Geofex tsxtech',
    0.21,
    4,
  ),
  'phase90': fidelityProfile('examples/pedals/phaser/phase90.pedal'),
  'ds1-dist': circuitProfile(
    'dsp/circuit/models/boss_ds1.cir',
    'Boss DS-1 board assy service schematic (hobby-hour); cross-checked with ElectroSmash and Aion FX Comet',
    0.56,
    4,
  ),
  'opamp-muff': circuitProfile(
    'dsp/circuit/models/opamp_big_muff.cir',
    "1978 op-amp Big Muff (V5) per Aion FX Corvus docs and tagboardeffects; Kit Rae's op-amp history for the reissue",
    0.67,
    4,
  ),
};

export function getEffectFidelity(effectId: string) {
  return EFFECT_FIDELITY_PROFILES[effectId] ?? null;
}
