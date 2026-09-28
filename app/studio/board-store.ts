/**
 * The board as one immutable document plus the actions that edit it. Every
 * edit goes through `boardReducer`, and `undoKeyFor` says which edits make an
 * undo step (and which of them coalesce, like the ticks of one knob drag), so
 * undo is recorded in exactly one place (see useBoard).
 */
import type { AudioChainItem, RoutingConfig, SignalLane } from '../audio/audio-core.ts';
import { normalizeInputSettings, type InputSettings, type SourceConfig } from '../audio/source-catalog.ts';
import type { ToneAgentBoardState } from '../agent/tone-agent-runtime.ts';
import { getAmpSpec, type AmpCabConfig } from '../amps/catalog.ts';
import { makeDefaultValues, type InstantiatedPreset, type PresetLayout } from '../effects/catalog.ts';
import { autoLayout, boardSize, footprintOf, jackPoint, nearestFreeSpot, plateRect, UTILITY_SIZE, type Rect } from './board-geometry.ts';
import {
  deriveChain,
  heal,
  MIXER_NODE,
  portsOf,
  pruneCables,
  repatch,
  splice,
  SPLITTER_NODE,
  INPUT_NODE,
  OUTPUT_NODE,
  type Cable,
  type PatchDoc,
  type Point,
} from './patch-graph.ts';
import { withCab, withCombo, withHead } from './rig-model.ts';

// The guitar input jack (focusing it opens the input deck) and the mixer box.
export { INPUT_NODE, MIXER_NODE } from './patch-graph.ts';

export type ChainItem = AudioChainItem;
export type Values = Record<string, Record<string, number>>;
export type SnapshotId = 'A' | 'B';
export type MonitorMode = 'dry' | 'wet';

export type BoardUiState = {
  /** Pedals on the signal path, in order: derived from the patch cables. */
  chain: ChainItem[];
  /** Pedals on the board but not cabled into the signal path (silent). */
  parked: ChainItem[];
  /** Where every pedal and utility box sits (mm) and the patch cables. */
  patch: PatchDoc;
  snapshots: Record<SnapshotId, Values>;
  snapshot: SnapshotId;
  /** The focused node: a pedal instance id, MIXER_NODE or RIG_NODE. */
  selected: string;
  bypassed: Set<string>;
  source: SourceConfig;
  /** Take, loop region and input trim (the take audio itself stays in the browser's take store). */
  input: InputSettings;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  output: number;
  mode: MonitorMode;
  activePresetName: string;
};

export const MAX_PEDALS = 16;
export const RIG_NODE = 'rig';
export const EDITED_NAME = '已修改';

export type BoardAction =
  | { type: 'add'; specId: string; instanceId: string; lane: SignalLane; index: number }
  | { type: 'move'; instanceId: string; lane: SignalLane; slot: number }
  | { type: 'nudge'; instanceId: string; direction: -1 | 1 }
  | { type: 'remove'; instanceId: string }
  | { type: 'bypass'; instanceId: string }
  | { type: 'setValue'; instanceId: string; controlId: string; value: number }
  | { type: 'selectCombo'; ampId: string }
  | { type: 'selectHead'; ampId: string }
  | { type: 'selectCab'; cabId: string }
  | { type: 'setAmpValue'; section: 'ampValues' | 'cabValues'; controlId: string; value: number }
  | { type: 'toggleAmpBypass' }
  | { type: 'setRouting'; routing: Partial<RoutingConfig> }
  | { type: 'setSource'; source: SourceConfig }
  | { type: 'setInput'; input: Partial<InputSettings> }
  | { type: 'setOutput'; output: number }
  | { type: 'setMode'; mode: MonitorMode }
  | { type: 'selectSnapshot'; snapshot: SnapshotId }
  | { type: 'copySnapshot' }
  | { type: 'focus'; id: string }
  | { type: 'applyPreset'; board: InstantiatedPreset; name: string }
  | { type: 'applyAgent'; board: ToneAgentBoardState; replaceSnapshots: boolean }
  | { type: 'rename'; name: string }
  | { type: 'restore'; state: BoardUiState }
  /** Free placement on the board (mm, top-left). */
  | { type: 'place'; id: string; x: number; y: number }
  /** A new set of patch cables (the signal chain follows them). */
  | { type: 'patch'; cables: Cable[] }
  /** Adds a pedal into an existing cable, at `at` if given. */
  | { type: 'insertOnCable'; specId: string; instanceId: string; cable: Cable; at?: Point }
  /** Cables a parked pedal onto the end of the chain (or of a lane). */
  | { type: 'connectParked'; instanceId: string; lane: SignalLane }
  /** Re-lays the board out in signal order with tidy cables. */
  | { type: 'tidy' };

export function cloneValues(values: Values) {
  return Object.fromEntries(Object.entries(values).map(([id, controls]) => [id, { ...controls }]));
}

export function clonePatch(patch: PatchDoc): PatchDoc {
  return {
    positions: Object.fromEntries(Object.entries(patch.positions).map(([id, point]) => [id, { ...point }])),
    cables: patch.cables.map((cable) => ({ from: { ...cable.from }, to: { ...cable.to } })),
  };
}

export function cloneBoardUiState(state: BoardUiState): BoardUiState {
  return {
    chain: state.chain.map((item) => ({ ...item })),
    parked: state.parked.map((item) => ({ ...item })),
    patch: clonePatch(state.patch),
    snapshots: { A: cloneValues(state.snapshots.A), B: cloneValues(state.snapshots.B) },
    snapshot: state.snapshot,
    selected: state.selected,
    bypassed: new Set(state.bypassed),
    source: { ...state.source },
    input: cloneInput(state.input),
    routing: { ...state.routing },
    amp: { ...state.amp, ampValues: { ...state.amp.ampValues }, cabValues: { ...state.amp.cabValues } },
    output: state.output,
    mode: state.mode,
    activePresetName: state.activePresetName,
  };
}

function cloneInput(input: InputSettings): InputSettings {
  return { ...input, loop: input.loop ? { ...input.loop } : null };
}

/** Both snapshots start as the preset; B diverges only when the player edits it. */
export function makeSnapshots(board: InstantiatedPreset) {
  return { A: cloneValues(board.values), B: cloneValues(board.values) };
}

export function boardFromPreset(board: InstantiatedPreset, name: string, mode: MonitorMode = 'wet'): BoardUiState {
  const chain = board.chain.map((item) => ({ ...item }));
  const parked = (board.layout?.parked ?? []).map((item) => ({ instanceId: item.instanceId, specId: item.specId }));
  const patch = patchFromLayout(board.layout, chain, board.routing.mode, parked);
  const settled = settleFromCables({ chain, parked, patch, routing: board.routing }, patch.cables);
  return {
    chain: settled.chain,
    parked: settled.parked,
    patch: settled.patch,
    snapshots: makeSnapshots(board),
    snapshot: 'A',
    selected: board.selectedInstanceId && board.chain.some((item) => item.instanceId === board.selectedInstanceId)
      ? board.selectedInstanceId
      : board.chain[0]?.instanceId ?? RIG_NODE,
    bypassed: new Set(board.bypassed),
    source: { ...board.source },
    input: normalizeInputSettings(board.input),
    routing: { ...board.routing },
    amp: { ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } },
    output: board.output,
    mode,
    activePresetName: name,
  };
}

type Topology = Pick<BoardUiState, 'chain' | 'parked' | 'patch' | 'routing'>;

function nodeSet(pedals: ChainItem[], mode: RoutingConfig['mode']) {
  const nodes = new Set([INPUT_NODE, OUTPUT_NODE, ...pedals.map((item) => item.instanceId)]);
  if (mode === 'parallel') {
    nodes.add(SPLITTER_NODE);
    nodes.add(MIXER_NODE);
  }
  return nodes;
}

/** Rects of every placed pedal and utility box (mm). */
export function occupiedRects(positions: Record<string, Point>, pedals: ChainItem[], except?: string): Array<Rect & { id: string }> {
  const rects: Array<Rect & { id: string }> = [];
  for (const item of pedals) {
    const point = positions[item.instanceId];
    if (point && item.instanceId !== except) rects.push({ id: item.instanceId, ...point, ...footprintOf(item.specId) });
  }
  for (const box of [SPLITTER_NODE, MIXER_NODE]) {
    const point = positions[box];
    if (point && box !== except) rects.push({ id: box, ...point, ...UTILITY_SIZE });
  }
  return rects;
}

/**
 * Gives every pedal (and, in parallel mode, the splitter and mixer) a spot on
 * the board: a new pedal lands just right of its predecessor in the chain,
 * or the nearest free spot to it; a board with nothing placed is laid out.
 */
function ensurePositions(positions: Record<string, Point>, chain: ChainItem[], parked: ChainItem[], mode: RoutingConfig['mode']) {
  const pedals = [...chain, ...parked];
  const next: Record<string, Point> = {};
  for (const item of pedals) if (positions[item.instanceId]) next[item.instanceId] = { ...positions[item.instanceId] };
  if (mode === 'parallel') {
    for (const box of [SPLITTER_NODE, MIXER_NODE]) if (positions[box]) next[box] = { ...positions[box] };
  }
  const missing = pedals.filter((item) => !next[item.instanceId]);
  const boxesMissing = mode === 'parallel' ? [SPLITTER_NODE, MIXER_NODE].filter((box) => !next[box]) : [];
  if (!missing.length && !boxesMissing.length) return next;
  if (missing.length === pedals.length) return autoLayout(chain, mode, parked);
  const auto = autoLayout(chain, mode, parked);
  for (const box of boxesMissing) {
    next[box] = nearestFreeSpot(auto[box], UTILITY_SIZE, occupiedRects(next, pedals)) ?? auto[box];
  }
  for (const item of missing) {
    const at = pedals.indexOf(item);
    const previous = pedals.slice(0, at).reverse().find((entry) => next[entry.instanceId]);
    const size = footprintOf(item.specId);
    const wanted = previous
      ? { x: next[previous.instanceId].x + footprintOf(previous.specId).w + 16, y: next[previous.instanceId].y }
      : auto[item.instanceId] ?? { x: 50, y: 20 };
    const rects = occupiedRects(next, pedals);
    const spot = nearestFreeSpot(wanted, size, rects);
    next[item.instanceId] = spot ?? { x: 50, y: Math.max(20, ...rects.map((rect) => rect.y + rect.h + 26)) };
  }
  return next;
}

const SOURCE_PORTS = new Set(['out', 'outA', 'outB']);
const SINK_PORTS = new Set(['in', 'inA', 'inB']);

/** Cables from a stored layout, keeping only well-formed ones. */
function validCables(raw: PresetLayout['cables'] | undefined): Cable[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((cable) => cable && typeof cable.from?.node === 'string' && typeof cable.to?.node === 'string'
    && SOURCE_PORTS.has(cable.from.port) && SINK_PORTS.has(cable.to.port)
    && portsOf(cable.from.node).includes(cable.from.port as Cable['from']['port'])
    && portsOf(cable.to.node).includes(cable.to.port as Cable['to']['port'])) as Cable[];
}

function patchFromLayout(layout: PresetLayout | undefined, chain: ChainItem[], mode: RoutingConfig['mode'], parked: ChainItem[]): PatchDoc {
  if (!layout) return { positions: autoLayout(chain, mode, parked), cables: repatch([], chain, mode, []) };
  const positions: Record<string, Point> = {};
  for (const [id, point] of Object.entries(layout.positions ?? {})) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { x: point.x, y: point.y };
  }
  const cables = validCables(layout.cables);
  return { positions, cables: cables.length ? cables : repatch([], chain, mode, []) };
}

/** Cables are authoritative: the chain and the parked pedals follow them. */
function settleFromCables(topology: Topology, cables: Cable[]) {
  const pedals = [...topology.chain, ...topology.parked];
  const mode = topology.routing.mode;
  const kept = pruneCables(cables, nodeSet(pedals, mode));
  const derived = deriveChain(pedals, kept, mode);
  const byId = new Map(pedals.map((item) => [item.instanceId, item]));
  const parked = derived.parked.map((id) => ({ instanceId: id, specId: byId.get(id)!.specId }));
  const positions = ensurePositions(topology.patch.positions, derived.chain, parked, mode);
  return { chain: derived.chain, parked, patch: { positions, cables: kept } };
}

/** The chain order is authoritative: it gets tidy cables, parked pedals keep theirs. */
function settleFromOrder(topology: Topology, chain: ChainItem[], parked: ChainItem[]) {
  const mode = topology.routing.mode;
  const ordered = chain.map((item) => ({ ...item, lane: mode === 'parallel' ? laneOf(item) : 'A' as const }));
  const cables = repatch(topology.patch.cables, ordered, mode, parked.map((item) => item.instanceId));
  return settleFromCables({ ...topology, chain: ordered, parked }, cables);
}

/** Signal-space rect of any board node, plates included. */
export function boardNodeRect(state: Pick<BoardUiState, 'chain' | 'parked' | 'patch'>, id: string): Rect | null {
  const pedals = [...state.chain, ...state.parked];
  if (id === INPUT_NODE || id === OUTPUT_NODE) return plateRect(id, boardSize(occupiedRects(state.patch.positions, pedals)));
  const point = state.patch.positions[id];
  if (!point) return null;
  if (id === SPLITTER_NODE || id === MIXER_NODE) return { ...point, ...UTILITY_SIZE };
  const item = pedals.find((entry) => entry.instanceId === id);
  return item ? { ...point, ...footprintOf(item.specId) } : null;
}

/** A free spot for a new pedal spliced into `cable`: centred on the cable, jacks level with it. */
export function spotForCableInsert(state: Pick<BoardUiState, 'chain' | 'parked' | 'patch'>, cable: Cable, specId: string): Point | null {
  const fromRect = boardNodeRect(state, cable.from.node);
  const toRect = boardNodeRect(state, cable.to.node);
  if (!fromRect || !toRect) return null;
  const a = jackPoint(fromRect, cable.from.node, cable.from.port);
  const b = jackPoint(toRect, cable.to.node, cable.to.port);
  const size = footprintOf(specId);
  const wanted = { x: (a.x + b.x) / 2 - size.w / 2, y: (a.y + b.y) / 2 - 24 };
  return nearestFreeSpot(wanted, size, occupiedRects(state.patch.positions, [...state.chain, ...state.parked]));
}

/** Whether the path from INPUT reaches OUTPUT (the board shows a warning if not). */
export function patchBroken(state: Pick<BoardUiState, 'chain' | 'parked' | 'patch' | 'routing'>) {
  return deriveChain([...state.chain, ...state.parked], state.patch.cables, state.routing.mode).broken;
}

/** Serialisable layout for presets. */
export function captureLayout(state: Pick<BoardUiState, 'parked' | 'patch'>): PresetLayout {
  const patch = clonePatch(state.patch);
  return { positions: patch.positions, cables: patch.cables, parked: state.parked.map((item) => ({ instanceId: item.instanceId, specId: item.specId })) };
}

export function laneOf(item: ChainItem): SignalLane {
  return item.lane ?? 'A';
}

/** The pedals of one signal row: the whole chain in serial mode. */
export function laneItems(chain: ChainItem[], mode: RoutingConfig['mode'], lane: SignalLane) {
  return mode === 'serial' ? chain : chain.filter((item) => laneOf(item) === lane);
}

/** Every focusable node in signal order: pedals, then the mixer and the rig. */
export function nodeOrder(state: Pick<BoardUiState, 'chain' | 'routing'>) {
  const pedals = state.routing.mode === 'serial'
    ? state.chain
    : [...laneItems(state.chain, 'parallel', 'A'), ...laneItems(state.chain, 'parallel', 'B')];
  return [...pedals.map((item) => item.instanceId), MIXER_NODE, RIG_NODE];
}

/** Inserts `item` before the lane's `index`th pedal (or after its last one). */
function insertAt(chain: ChainItem[], item: ChainItem, mode: RoutingConfig['mode'], lane: SignalLane, index: number) {
  const row = laneItems(chain, mode, lane);
  const anchor = row[Math.max(0, index)];
  if (anchor) {
    const at = chain.indexOf(anchor);
    return [...chain.slice(0, at), item, ...chain.slice(at)];
  }
  if (mode === 'serial' || row.length === 0) return [...chain, item];
  const at = chain.indexOf(row[row.length - 1]) + 1;
  return [...chain.slice(0, at), item, ...chain.slice(at)];
}

function pedalCount(state: Pick<BoardUiState, 'chain' | 'parked'>) {
  return state.chain.length + state.parked.length;
}

function hasPedal(state: Pick<BoardUiState, 'chain' | 'parked'>, instanceId: string) {
  return state.chain.some((item) => item.instanceId === instanceId) || state.parked.some((item) => item.instanceId === instanceId);
}

function withoutInstance(values: Values, instanceId: string) {
  const next = { ...values };
  delete next[instanceId];
  return next;
}

function edited(state: BoardUiState, patch: Partial<BoardUiState>): BoardUiState {
  return { ...state, ...patch, activePresetName: EDITED_NAME };
}

export function boardReducer(state: BoardUiState, action: BoardAction): BoardUiState {
  switch (action.type) {
    case 'add': {
      if (pedalCount(state) >= MAX_PEDALS || hasPedal(state, action.instanceId)) return state;
      const lane = state.routing.mode === 'parallel' ? action.lane : 'A';
      const item: ChainItem = { instanceId: action.instanceId, specId: action.specId, lane };
      const defaults = makeDefaultValues(action.specId);
      return edited(state, {
        ...settleFromOrder(state, insertAt(state.chain, item, state.routing.mode, lane, action.index), state.parked),
        snapshots: {
          A: { ...state.snapshots.A, [action.instanceId]: { ...defaults } },
          B: { ...state.snapshots.B, [action.instanceId]: { ...defaults } },
        },
        selected: action.instanceId,
      });
    }
    case 'move': {
      const moving = state.chain.find((item) => item.instanceId === action.instanceId);
      if (!moving) return state;
      const mode = state.routing.mode;
      const lane = mode === 'parallel' ? action.lane : laneOf(moving);
      const sameRow = mode === 'serial' || laneOf(moving) === lane;
      // `slot` counts positions in the row as displayed, moving pedal included.
      const from = laneItems(state.chain, mode, lane).indexOf(moving);
      if (sameRow && (action.slot === from || action.slot === from + 1)) return state;
      const index = sameRow && action.slot > from ? action.slot - 1 : action.slot;
      const rest = state.chain.filter((item) => item !== moving);
      return edited(state, settleFromOrder(state, insertAt(rest, { ...moving, lane }, mode, lane, index), state.parked));
    }
    case 'nudge': {
      const moving = state.chain.find((item) => item.instanceId === action.instanceId);
      if (!moving) return state;
      const row = laneItems(state.chain, state.routing.mode, laneOf(moving));
      const from = row.indexOf(moving);
      const to = from + action.direction;
      if (to < 0 || to >= row.length) return state;
      return boardReducer(state, { type: 'move', instanceId: action.instanceId, lane: laneOf(moving), slot: action.direction > 0 ? to + 1 : to });
    }
    case 'remove': {
      if (!hasPedal(state, action.instanceId)) return state;
      const order = nodeOrder(state);
      const at = order.indexOf(action.instanceId);
      const chain = state.chain.filter((item) => item.instanceId !== action.instanceId);
      const parked = state.parked.filter((item) => item.instanceId !== action.instanceId);
      const neighbour = [order[at - 1], order[at + 1]].find((id) => id && chain.some((item) => item.instanceId === id));
      const bypassed = new Set(state.bypassed);
      bypassed.delete(action.instanceId);
      // Pulling a pedal out joins the cable that went into it to the one that came out.
      const settled = settleFromCables({ ...state, chain, parked }, heal(state.patch.cables, action.instanceId));
      return edited(state, {
        ...settled,
        snapshots: { A: withoutInstance(state.snapshots.A, action.instanceId), B: withoutInstance(state.snapshots.B, action.instanceId) },
        bypassed,
        selected: state.selected === action.instanceId ? neighbour ?? RIG_NODE : state.selected,
      });
    }
    case 'bypass': {
      if (!hasPedal(state, action.instanceId)) return state;
      const bypassed = new Set(state.bypassed);
      if (bypassed.has(action.instanceId)) bypassed.delete(action.instanceId);
      else bypassed.add(action.instanceId);
      return edited(state, { bypassed });
    }
    case 'setValue': {
      const current = state.snapshots[state.snapshot];
      if (current[action.instanceId]?.[action.controlId] === action.value) return state;
      return edited(state, {
        snapshots: {
          ...state.snapshots,
          [state.snapshot]: { ...current, [action.instanceId]: { ...current[action.instanceId], [action.controlId]: action.value } },
        },
      });
    }
    // A combo brings its own speaker: amp and cab change together, one undo step.
    case 'selectCombo':
      return state.amp.ampId === action.ampId && state.amp.cabId === getAmpSpec(action.ampId).speakerCab
        ? state
        : edited(state, { amp: withCombo(state.amp, getAmpSpec(action.ampId)) });
    case 'selectHead':
      return state.amp.ampId === action.ampId ? state : edited(state, { amp: withHead(state.amp, getAmpSpec(action.ampId)) });
    case 'selectCab':
      return state.amp.cabId === action.cabId ? state : edited(state, { amp: withCab(state.amp, action.cabId) });
    case 'setAmpValue':
      if (state.amp[action.section][action.controlId] === action.value) return state;
      return edited(state, { amp: { ...state.amp, [action.section]: { ...state.amp[action.section], [action.controlId]: action.value } } });
    case 'toggleAmpBypass':
      return edited(state, { amp: { ...state.amp, bypassed: !state.amp.bypassed } });
    case 'setRouting': {
      const routing = { ...state.routing, ...action.routing };
      if (routing.mode === state.routing.mode && routing.blend === state.routing.blend && routing.spread === state.routing.spread) return state;
      if (routing.mode === state.routing.mode) return edited(state, { routing });
      // Switching modes adds or removes the splitter and mixer and re-cables the chain.
      return edited(state, { routing, ...settleFromOrder({ ...state, routing }, state.chain, state.parked) });
    }
    case 'place': {
      const current = state.patch.positions[action.id];
      if (!current || (current.x === action.x && current.y === action.y)) return state;
      return edited(state, { patch: { ...state.patch, positions: { ...state.patch.positions, [action.id]: { x: action.x, y: action.y } } } });
    }
    case 'patch':
      return edited(state, settleFromCables(state, action.cables));
    case 'insertOnCable': {
      if (pedalCount(state) >= MAX_PEDALS || hasPedal(state, action.instanceId)) return state;
      const cables = splice(state.patch.cables, action.cable, action.instanceId);
      if (!cables) return state;
      const item: ChainItem = { instanceId: action.instanceId, specId: action.specId, lane: 'A' };
      const positions = action.at ? { ...state.patch.positions, [action.instanceId]: { ...action.at } } : state.patch.positions;
      const defaults = makeDefaultValues(action.specId);
      return edited(state, {
        ...settleFromCables({ ...state, parked: [...state.parked, item], patch: { positions, cables: state.patch.cables } }, cables),
        snapshots: {
          A: { ...state.snapshots.A, [action.instanceId]: { ...defaults } },
          B: { ...state.snapshots.B, [action.instanceId]: { ...defaults } },
        },
        selected: action.instanceId,
      });
    }
    case 'connectParked': {
      const item = state.parked.find((entry) => entry.instanceId === action.instanceId);
      if (!item) return state;
      const lane = state.routing.mode === 'parallel' ? action.lane : 'A';
      const chain = insertAt(state.chain, { ...item, lane }, state.routing.mode, lane, Number.MAX_SAFE_INTEGER);
      return edited(state, settleFromOrder(state, chain, state.parked.filter((entry) => entry !== item)));
    }
    case 'tidy': {
      const cables = repatch(state.patch.cables, state.chain, state.routing.mode, state.parked.map((item) => item.instanceId));
      return edited(state, { patch: { positions: autoLayout(state.chain, state.routing.mode, state.parked), cables } });
    }
    case 'setSource':
      // Picking an example phrase also stops playing a take.
      return edited(state, { source: action.source, input: { ...state.input, takeId: null, loop: state.input.takeId ? null : state.input.loop } });
    case 'setInput': {
      const input = normalizeInputSettings({ ...state.input, ...action.input });
      const same = input.takeId === state.input.takeId && input.trimDb === state.input.trimDb &&
        input.loop?.start === state.input.loop?.start && input.loop?.end === state.input.loop?.end;
      return same ? state : edited(state, { input });
    }
    case 'setOutput':
      return state.output === action.output ? state : edited(state, { output: action.output });
    case 'setMode':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'selectSnapshot':
      return state.snapshot === action.snapshot ? state : { ...state, snapshot: action.snapshot };
    /** Copies the active snapshot over the other one, so B can start as a variation of A. */
    case 'copySnapshot': {
      const other: SnapshotId = state.snapshot === 'A' ? 'B' : 'A';
      return { ...state, snapshots: { ...state.snapshots, [other]: cloneValues(state.snapshots[state.snapshot]) } };
    }
    case 'focus':
      return state.selected === action.id ? state : { ...state, selected: action.id };
    case 'applyPreset':
      return boardFromPreset(action.board, action.name, state.mode);
    case 'applyAgent':
      return applyAgentBoard(state, action.board, action.replaceSnapshots);
    case 'rename':
      return state.activePresetName === action.name ? state : { ...state, activePresetName: action.name };
    case 'restore':
      return cloneBoardUiState(action.state);
  }
}

/**
 * Agent local updates retain the inactive A/B snapshot (pedals still on the
 * board keep their other-snapshot values) while replacements reset both.
 */
function applyAgentBoard(state: BoardUiState, board: ToneAgentBoardState, replaceSnapshots: boolean): BoardUiState {
  const nextValues = cloneValues(board.values);
  let snapshots: Record<SnapshotId, Values>;
  if (replaceSnapshots) {
    snapshots = { A: nextValues, B: cloneValues(nextValues) };
  } else {
    const inactiveSnapshot = state.snapshot === 'A' ? 'B' : 'A';
    const boardIds = new Set(board.chain.map((item) => item.instanceId));
    const preservedInactive = Object.fromEntries(
      Object.entries(state.snapshots[inactiveSnapshot])
        .filter(([instanceId]) => boardIds.has(instanceId))
        .map(([instanceId, values]) => [instanceId, { ...values }]),
    ) as Values;
    board.chain.forEach((item) => {
      if (!preservedInactive[item.instanceId]) preservedInactive[item.instanceId] = { ...(nextValues[item.instanceId] ?? {}) };
    });
    snapshots = state.snapshot === 'A'
      ? { A: nextValues, B: preservedInactive }
      : { A: preservedInactive, B: nextValues };
  }
  // Parked pedals are not part of what the agent saw: they stay where they are.
  const agentIds = new Set(board.chain.map((item) => item.instanceId));
  const parked = state.parked.filter((item) => !agentIds.has(item.instanceId));
  for (const item of parked) {
    for (const id of ['A', 'B'] as const) {
      const previous = state.snapshots[id][item.instanceId] ?? state.snapshots[state.snapshot][item.instanceId];
      if (previous) snapshots[id] = { ...snapshots[id], [item.instanceId]: { ...previous } };
    }
  }
  const settled = settleFromOrder({ ...state, routing: { ...board.routing } }, board.chain.map((item) => ({ ...item })), parked);
  return {
    ...settled,
    snapshots,
    snapshot: replaceSnapshots ? 'A' : state.snapshot,
    selected: board.chain[0]?.instanceId ?? RIG_NODE,
    bypassed: new Set(board.bypassed),
    source: { ...board.source },
    // The agent does not see takes: the input (take, loop, trim) stays as it was.
    input: cloneInput(state.input),
    routing: { ...board.routing },
    amp: { ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } },
    output: board.output,
    mode: board.monitorMode,
    activePresetName: board.name,
  };
}

/**
 * Which edits are undo steps. Knob and slider ticks share a key per control
 * so a drag is one step; every other edit is its own step ('discrete').
 * Focus, A/B switching, monitoring, output level, renames and restores are
 * not edits and return null.
 */
export function undoKeyFor(action: BoardAction): string | 'discrete' | null {
  switch (action.type) {
    case 'setValue':
      return `value:${action.instanceId}:${action.controlId}`;
    case 'setAmpValue':
      return `amp:${action.section}:${action.controlId}`;
    // A trim drag or a loop-handle drag is one step; choosing a take is its own.
    case 'setInput':
      return 'takeId' in action.input ? 'discrete' : `input:${Object.keys(action.input).sort().join(',')}`;
    case 'setRouting':
      return action.routing.mode === undefined ? `routing:${Object.keys(action.routing).sort().join(',')}` : 'discrete';
    case 'place':
      return `place:${action.id}`;
    case 'add':
    case 'patch':
    case 'insertOnCable':
    case 'connectParked':
    case 'tidy':
    case 'move':
    case 'nudge':
    case 'remove':
    case 'bypass':
    case 'selectCombo':
    case 'selectHead':
    case 'selectCab':
    case 'toggleAmpBypass':
    case 'setSource':
    case 'copySnapshot':
    case 'applyPreset':
    case 'applyAgent':
      return 'discrete';
    default:
      return null;
  }
}
