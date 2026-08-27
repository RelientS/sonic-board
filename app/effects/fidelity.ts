export type EffectFidelityProfile = {
  engine: 'PedalKernel WDF' | 'Legacy Web Audio fallback';
  upstreamCommit: string;
  upstreamModel: string;
  targetScore: number;
  verifiedScore: number | null;
  evidence: Array<'upstream-circuit' | 'runtime-regression' | 'hardware-abx'>;
  runtime: 'pedalkernel' | 'legacy-fallback';
  status: 'candidate' | 'blocked';
  note: string;
};

const PEDALKERNEL_COMMIT = '0278b397c861b5ebef2e8e38d15ab281b8e669dc';

const fidelityProfile = (
  upstreamModel: string,
  runtime: EffectFidelityProfile['runtime'],
  note: string,
): EffectFidelityProfile => ({
  engine: runtime === 'pedalkernel' ? 'PedalKernel WDF' : 'Legacy Web Audio fallback',
  upstreamCommit: PEDALKERNEL_COMMIT,
  upstreamModel,
  targetScore: 8,
  verifiedScore: null,
  evidence: ['upstream-circuit', 'runtime-regression'],
  runtime,
  status: runtime === 'pedalkernel' ? 'candidate' : 'blocked',
  note,
});

export const EFFECT_FIDELITY_PROFILES: Record<string, EffectFidelityProfile> = {
  'studio-comp': fidelityProfile(
    'examples/pedals/compressor/dyna_comp.pedal',
    'pedalkernel',
    '浏览器持续输出门禁已通过；仍需与真实硬件盲测后才能给出还原分。',
  ),
  'rodent-dist': fidelityProfile(
    'examples/pedals/distortion/proco_rat.pedal',
    'pedalkernel',
    '浏览器持续输出门禁已通过；仍需与真实硬件盲测后才能给出还原分。',
  ),
  'blue-drive': fidelityProfile(
    'examples/pedals/overdrive/blues_driver.pedal',
    'legacy-fallback',
    'PedalKernel 候选模型未通过持续输出门禁，当前保留旧引擎。',
  ),
  'wall-fuzz': fidelityProfile(
    'examples/pedals/fuzz/big_muff.pedal',
    'legacy-fallback',
    'PedalKernel 候选模型未通过持续输出门禁，当前保留旧引擎。',
  ),
};

export function getEffectFidelity(effectId: string) {
  return EFFECT_FIDELITY_PROFILES[effectId] ?? null;
}
