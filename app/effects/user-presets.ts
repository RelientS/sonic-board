import type { SourceKind } from '../audio/audio-core';
import { getEffectSpec, makeDefaultValues, type InstantiatedPreset } from './catalog.ts';

export type UserPreset = {
  id: string;
  name: string;
  createdAt: number;
  source: SourceKind;
  output: number;
  chain: Array<{
    specId: string;
    settings: Record<string, number>;
    bypassed: boolean;
  }>;
};

type BoardCapture = {
  name: string;
  chain: Array<{ instanceId: string; specId: string }>;
  values: Record<string, Record<string, number>>;
  bypassed: Set<string>;
  source: SourceKind;
  output: number;
};

let userPresetSerial = 0;

export function captureUserPreset(board: BoardCapture, id = `preset-${Date.now()}`, createdAt = Date.now()): UserPreset {
  return {
    id,
    name: board.name.trim() || '未命名音色',
    createdAt,
    source: board.source,
    output: Math.min(100, Math.max(0, board.output)),
    chain: board.chain.map((item) => ({
      specId: item.specId,
      settings: { ...makeDefaultValues(item.specId), ...board.values[item.instanceId] },
      bypassed: board.bypassed.has(item.instanceId),
    })),
  };
}

export function instantiateUserPreset(preset: UserPreset): InstantiatedPreset {
  userPresetSerial += 1;
  const chain = preset.chain.map((item, index) => ({ instanceId: `${item.specId}-user-${userPresetSerial}-${index + 1}`, specId: item.specId }));
  const values = Object.fromEntries(chain.map((item, index) => [
    item.instanceId,
    { ...makeDefaultValues(item.specId), ...preset.chain[index].settings },
  ]));
  const bypassed = chain.filter((_, index) => preset.chain[index].bypassed).map((item) => item.instanceId);
  return { chain, values, bypassed, source: preset.source, output: preset.output };
}

function isUserPreset(value: unknown): value is UserPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<UserPreset>;
  if (typeof preset.id !== 'string' || typeof preset.name !== 'string' || typeof preset.createdAt !== 'number') return false;
  if (!['chords', 'arpeggio', 'lead'].includes(preset.source ?? '')) return false;
  if (typeof preset.output !== 'number' || !Array.isArray(preset.chain) || preset.chain.length === 0) return false;
  return preset.chain.every((item) => {
    if (!item || typeof item !== 'object' || typeof item.specId !== 'string' || typeof item.bypassed !== 'boolean') return false;
    try { getEffectSpec(item.specId); } catch { return false; }
    return Boolean(item.settings) && typeof item.settings === 'object' && Object.values(item.settings).every((setting) => typeof setting === 'number' && Number.isFinite(setting));
  });
}

export function parseUserPresets(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUserPreset).sort((a, b) => b.createdAt - a.createdAt).slice(0, 24);
  } catch {
    return [];
  }
}
