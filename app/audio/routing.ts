import { clampParameter, type AudioChainItem, type RoutingMode } from './audio-core.ts';

export function partitionChain(chain: AudioChainItem[], mode: RoutingMode) {
  if (mode === 'serial') return { serial: [...chain], A: [], B: [] };
  return {
    serial: [],
    A: chain.filter((item) => (item.lane ?? 'A') === 'A'),
    B: chain.filter((item) => item.lane === 'B'),
  };
}

function tidy(value: number) {
  return Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(6));
}

export function computeLaneMix(blendValue: number, spreadValue: number) {
  const blend = clampParameter(blendValue) / 100;
  const spread = clampParameter(spreadValue) / 100;
  return {
    A: { gain: tidy(Math.cos(blend * Math.PI * 0.5)), pan: tidy(-spread) },
    B: { gain: tidy(Math.sin(blend * Math.PI * 0.5)), pan: tidy(spread) },
  };
}
