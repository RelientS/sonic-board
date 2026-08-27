export type EffectFidelityProfile = {
  engine: 'PedalKernel WDF + calibrated corrections';
  upstreamCommit: string;
  upstreamModel: string;
  targetScore: number;
  verifiedScore: number | null;
  evidence: Array<'upstream-circuit' | 'runtime-regression' | 'hardware-abx'>;
  runtime: 'pedalkernel';
  status: 'candidate';
  note: string;
};

const PEDALKERNEL_COMMIT = '0278b397c861b5ebef2e8e38d15ab281b8e669dc';

const fidelityProfile = (upstreamModel: string): EffectFidelityProfile => ({
  engine: 'PedalKernel WDF + calibrated corrections',
  upstreamCommit: PEDALKERNEL_COMMIT,
  upstreamModel,
  targetScore: 8,
  verifiedScore: null,
  evidence: ['upstream-circuit', 'runtime-regression'],
  runtime: 'pedalkernel',
  status: 'candidate',
  note: '持续输出、有限值、输出校准和控制响应门禁已通过；仍需与真实硬件盲测后才能给出还原分。',
});

export const EFFECT_FIDELITY_PROFILES: Record<string, EffectFidelityProfile> = {
  'studio-comp': fidelityProfile('examples/pedals/compressor/dyna_comp.pedal'),
  'blue-drive': fidelityProfile('examples/pedals/overdrive/blues_driver.pedal'),
  'rodent-dist': fidelityProfile('examples/pedals/distortion/proco_rat.pedal'),
  'wall-fuzz': fidelityProfile('examples/pedals/fuzz/big_muff.pedal'),
  'dm2-delay': fidelityProfile('examples/pedals/delay/boss_dm2.pedal'),
  'analog-delay': fidelityProfile('examples/pedals/delay/memory_man.pedal'),
  'fuzz-face': fidelityProfile('examples/pedals/fuzz/fuzz_face.pedal'),
  'analog-chorus': fidelityProfile('examples/pedals/modulation/boss_ce2.pedal'),
  'ocd-drive': fidelityProfile('examples/pedals/overdrive/fulltone_ocd.pedal'),
  'klon-centaur': fidelityProfile('examples/pedals/overdrive/klon_centaur.pedal'),
  'sd1-drive': fidelityProfile('examples/pedals/overdrive/sd1.pedal'),
  'tube-screamer': fidelityProfile('examples/pedals/overdrive/tube_screamer.pedal'),
  'phase90': fidelityProfile('examples/pedals/phaser/phase90.pedal'),
};

export function getEffectFidelity(effectId: string) {
  return EFFECT_FIDELITY_PROFILES[effectId] ?? null;
}
