import type { RoutingConfig, SignalLane } from '../audio/audio-core';
import { normalizeSourceConfig, type SourceConfig } from '../audio/source-catalog.ts';
import {
  getAmpSpec,
  getCabSpec,
  makeAmpCabConfig,
  makeDefaultAmpCabConfig,
  type AmpCabConfig,
} from '../amps/catalog.ts';
import { getEffectSpec, makeDefaultValues, type InstantiatedPreset } from './catalog.ts';

export type UserPreset = {
  id: string;
  name: string;
  createdAt: number;
  source: SourceConfig;
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  chain: Array<{
    specId: string;
    lane: SignalLane;
    settings: Record<string, number>;
    bypassed: boolean;
  }>;
};

type BoardCapture = {
  name: string;
  chain: Array<{ instanceId: string; specId: string; lane?: SignalLane }>;
  values: Record<string, Record<string, number>>;
  bypassed: Set<string>;
  source: SourceConfig;
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
};

let userPresetSerial = 0;

function cloneAmp(amp: AmpCabConfig): AmpCabConfig {
  return {
    ...amp,
    ampValues: { ...amp.ampValues },
    cabValues: { ...amp.cabValues },
  };
}

function normalizeEffectSettings(specId: string, settings: Record<string, number>) {
  const defaults = makeDefaultValues(specId);
  return Object.fromEntries(Object.keys(defaults).map((id) => [id, settings[id] ?? defaults[id]]));
}

export function captureUserPreset(board: BoardCapture, id = `preset-${Date.now()}`, createdAt = Date.now()): UserPreset {
  return {
    id,
    name: board.name.trim() || '未命名音色',
    createdAt,
    source: board.source,
    output: Math.min(100, Math.max(0, board.output)),
    routing: {
      mode: board.routing.mode,
      blend: Math.min(100, Math.max(0, board.routing.blend)),
      spread: Math.min(100, Math.max(0, board.routing.spread)),
    },
    amp: cloneAmp(board.amp),
    chain: board.chain.map((item) => ({
      specId: item.specId,
      lane: item.lane ?? 'A',
      settings: normalizeEffectSettings(item.specId, board.values[item.instanceId] ?? {}),
      bypassed: board.bypassed.has(item.instanceId),
    })),
  };
}

export function instantiateUserPreset(preset: UserPreset): InstantiatedPreset {
  userPresetSerial += 1;
  const chain = preset.chain.map((item, index) => ({
    instanceId: `${item.specId}-user-${userPresetSerial}-${index + 1}`,
    specId: item.specId,
    lane: item.lane ?? 'A',
  }));
  const values = Object.fromEntries(chain.map((item, index) => [
    item.instanceId,
    normalizeEffectSettings(item.specId, preset.chain[index].settings),
  ]));
  const bypassed = chain.filter((_, index) => preset.chain[index].bypassed).map((item) => item.instanceId);
  return {
    chain,
    values,
    bypassed,
    source: normalizeSourceConfig(preset.source),
    output: preset.output,
    routing: preset.routing ? { ...preset.routing } : { mode: 'serial', blend: 50, spread: 0 },
    amp: preset.amp ? cloneAmp(preset.amp) : makeDefaultAmpCabConfig(),
  };
}

function isFiniteNumberMap(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object' && Object.values(value).every((setting) => typeof setting === 'number' && Number.isFinite(setting));
}

function normalizeAmp(value: unknown) {
  if (!value || typeof value !== 'object') return makeDefaultAmpCabConfig();
  const candidate = value as Partial<AmpCabConfig>;
  if (typeof candidate.ampId !== 'string' || typeof candidate.cabId !== 'string') return makeDefaultAmpCabConfig();
  try {
    getAmpSpec(candidate.ampId);
    getCabSpec(candidate.cabId);
  } catch {
    return makeDefaultAmpCabConfig();
  }
  return {
    ...makeAmpCabConfig(
      candidate.ampId,
      candidate.cabId,
      isFiniteNumberMap(candidate.ampValues) ? candidate.ampValues : {},
      isFiniteNumberMap(candidate.cabValues) ? candidate.cabValues : {},
    ),
    bypassed: candidate.bypassed === true,
  };
}

function normalizeUserPreset(value: unknown): UserPreset | null {
  if (!value || typeof value !== 'object') return null;
  const preset = value as Partial<UserPreset>;
  if (typeof preset.id !== 'string' || typeof preset.name !== 'string' || typeof preset.createdAt !== 'number') return null;
  if (typeof preset.output !== 'number' || !Array.isArray(preset.chain) || preset.chain.length === 0) return null;

  const chain = preset.chain.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.specId !== 'string' || typeof item.bypassed !== 'boolean') return null;
    try { getEffectSpec(item.specId); } catch { return null; }
    if (!isFiniteNumberMap(item.settings)) return null;
    return {
      specId: item.specId,
      lane: item.lane === 'B' ? 'B' as const : 'A' as const,
      settings: normalizeEffectSettings(item.specId, item.settings),
      bypassed: item.bypassed,
    };
  });
  if (chain.some((item) => item === null)) return null;

  const routingCandidate = preset.routing;
  const routing: RoutingConfig = routingCandidate && (routingCandidate.mode === 'serial' || routingCandidate.mode === 'parallel')
    ? {
        mode: routingCandidate.mode,
        blend: Math.min(100, Math.max(0, Number.isFinite(routingCandidate.blend) ? routingCandidate.blend : 50)),
        spread: Math.min(100, Math.max(0, Number.isFinite(routingCandidate.spread) ? routingCandidate.spread : 0)),
      }
    : { mode: 'serial', blend: 50, spread: 0 };

  return {
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    source: normalizeSourceConfig(preset.source),
    output: Math.min(100, Math.max(0, preset.output)),
    routing,
    amp: normalizeAmp(preset.amp),
    chain: chain as UserPreset['chain'],
  };
}

export function parseUserPresets(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeUserPreset)
      .filter((preset): preset is UserPreset => preset !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 24);
  } catch {
    return [];
  }
}
