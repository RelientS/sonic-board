import type { RoutingConfig, SignalLane } from '../audio/audio-core';
import { normalizeInputSettings, normalizeSourceConfig, type InputSettings, type SourceConfig } from '../audio/source-catalog.ts';
import {
  getAmpSpec,
  getCabSpec,
  makeAmpCabConfig,
  makeDefaultAmpCabConfig,
  type AmpCabConfig,
} from '../amps/catalog.ts';
import { getEffectSpec, makeDefaultValues, type InstantiatedPreset, type PresetLayout } from './catalog.ts';

export type UserPreset = {
  id: string;
  name: string;
  createdAt: number;
  source: SourceConfig;
  /** Only the take id, loop and trim; the take audio stays in this browser. */
  input?: InputSettings;
  output: number;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  chain: Array<{
    specId: string;
    lane: SignalLane;
    settings: Record<string, number>;
    bypassed: boolean;
    /** On the board but not cabled into the signal path. */
    parked?: boolean;
  }>;
  /** Board positions and cables; pedals are referenced as `#<chain index>`. */
  layout?: StoredLayout;
};

type StoredLayout = { positions: Record<string, { x: number; y: number }>; cables: PresetLayout['cables'] };

type BoardCapture = {
  name: string;
  chain: Array<{ instanceId: string; specId: string; lane?: SignalLane }>;
  /** Pedals on the board but off the signal path, and where everything sits. */
  parked?: Array<{ instanceId: string; specId: string }>;
  layout?: PresetLayout;
  values: Record<string, Record<string, number>>;
  bypassed: Set<string>;
  source: SourceConfig;
  input?: InputSettings;
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

/** Rewrites node ids through `rename` (utility nodes like 'input' keep theirs). */
function mapLayout(layout: { positions: Record<string, { x: number; y: number }>; cables: PresetLayout['cables'] }, rename: (id: string) => string | undefined) {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, point] of Object.entries(layout.positions)) {
    const next = rename(id);
    if (next) positions[next] = { x: point.x, y: point.y };
  }
  const cables = layout.cables.flatMap((cable) => {
    const from = rename(cable.from.node);
    const to = rename(cable.to.node);
    return from && to ? [{ from: { node: from, port: cable.from.port }, to: { node: to, port: cable.to.port } }] : [];
  });
  return { positions, cables };
}

const UTILITY_NODES = new Set(['input', 'output', 'splitter', 'mixer']);

export function captureUserPreset(board: BoardCapture, id = `preset-${Date.now()}`, createdAt = Date.now()): UserPreset {
  const all = [...board.chain, ...(board.parked ?? []).map((item) => ({ ...item, parked: true }))];
  const indexOf = new Map(all.map((item, index) => [item.instanceId, `#${index}`]));
  const layout = board.layout ? mapLayout(board.layout, (node) => indexOf.get(node) ?? (UTILITY_NODES.has(node) ? node : undefined)) : undefined;
  return {
    id,
    name: board.name.trim() || '未命名音色',
    createdAt,
    source: board.source,
    ...(board.input ? { input: normalizeInputSettings(board.input) } : {}),
    output: Math.min(100, Math.max(0, board.output)),
    routing: {
      mode: board.routing.mode,
      blend: Math.min(100, Math.max(0, board.routing.blend)),
      spread: Math.min(100, Math.max(0, board.routing.spread)),
    },
    amp: cloneAmp(board.amp),
    chain: all.map((item) => ({
      specId: item.specId,
      lane: ('lane' in item && item.lane) || 'A',
      settings: normalizeEffectSettings(item.specId, board.values[item.instanceId] ?? {}),
      bypassed: board.bypassed.has(item.instanceId),
      ...('parked' in item ? { parked: true } : {}),
    })),
    ...(layout ? { layout } : {}),
  };
}

export function instantiateUserPreset(preset: UserPreset): InstantiatedPreset {
  userPresetSerial += 1;
  const all = preset.chain.map((item, index) => ({
    instanceId: `${item.specId}-user-${userPresetSerial}-${index + 1}`,
    specId: item.specId,
    lane: item.lane ?? 'A',
  }));
  const values = Object.fromEntries(all.map((item, index) => [
    item.instanceId,
    normalizeEffectSettings(item.specId, preset.chain[index].settings),
  ]));
  const bypassed = all.filter((_, index) => preset.chain[index].bypassed).map((item) => item.instanceId);
  const chain = all.filter((_, index) => !preset.chain[index].parked);
  const parked = all.filter((_, index) => preset.chain[index].parked).map((item) => ({ instanceId: item.instanceId, specId: item.specId }));
  const layout = preset.layout
    ? { ...mapLayout(preset.layout, (node) => (node.startsWith('#') ? all[Number(node.slice(1))]?.instanceId : UTILITY_NODES.has(node) ? node : undefined)), parked }
    : undefined;
  return {
    chain,
    ...(layout ? { layout } : {}),
    values,
    bypassed,
    source: normalizeSourceConfig(preset.source),
    input: normalizeInputSettings(preset.input),
    output: preset.output,
    routing: preset.routing ? { ...preset.routing } : { mode: 'serial', blend: 50, spread: 0 },
    amp: preset.amp ? cloneAmp(preset.amp) : makeDefaultAmpCabConfig(),
  };
}

function isFiniteNumberMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((setting) => typeof setting === 'number' && Number.isFinite(setting));
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
      ...(item.parked === true ? { parked: true } : {}),
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
    ...(preset.input ? { input: normalizeInputSettings(preset.input) } : {}),
    output: Math.min(100, Math.max(0, preset.output)),
    routing,
    amp: normalizeAmp(preset.amp),
    chain: chain as UserPreset['chain'],
    ...(normalizeLayout(preset.layout) ? { layout: normalizeLayout(preset.layout)! } : {}),
  };
}

/** Keeps a stored layout only if it has the expected shape (cables are re-validated on load). */
function normalizeLayout(value: unknown): StoredLayout | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredLayout>;
  if (!candidate.positions || typeof candidate.positions !== 'object' || !Array.isArray(candidate.cables)) return null;
  const positions: StoredLayout['positions'] = {};
  for (const [id, point] of Object.entries(candidate.positions)) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { x: point.x, y: point.y };
  }
  const cables = candidate.cables.filter((cable) => cable && typeof cable.from?.node === 'string' && typeof cable.from?.port === 'string'
    && typeof cable.to?.node === 'string' && typeof cable.to?.port === 'string');
  return { positions, cables };
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
