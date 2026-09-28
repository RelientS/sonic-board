/**
 * The board as one immutable document plus the actions that edit it. Every
 * edit goes through `boardReducer`, and `undoKeyFor` says which edits make an
 * undo step (and which of them coalesce, like the ticks of one knob drag), so
 * undo is recorded in exactly one place (see useBoard).
 */
import type { AudioChainItem, RoutingConfig, SignalLane } from '../audio/audio-core.ts';
import type { SourceConfig } from '../audio/source-catalog.ts';
import type { ToneAgentBoardState } from '../agent/tone-agent-runtime.ts';
import { getAmpSpec, type AmpCabConfig } from '../amps/catalog.ts';
import { makeDefaultValues, type InstantiatedPreset } from '../effects/catalog.ts';
import { withCab, withCombo, withHead } from './rig-model.ts';

export type ChainItem = AudioChainItem;
export type Values = Record<string, Record<string, number>>;
export type SnapshotId = 'A' | 'B';
export type MonitorMode = 'dry' | 'wet';

export type BoardUiState = {
  chain: ChainItem[];
  snapshots: Record<SnapshotId, Values>;
  snapshot: SnapshotId;
  /** The focused node: a pedal instance id, MIXER_NODE or RIG_NODE. */
  selected: string;
  bypassed: Set<string>;
  source: SourceConfig;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  output: number;
  mode: MonitorMode;
  activePresetName: string;
};

export const MAX_PEDALS = 16;
export const MIXER_NODE = 'mixer';
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
  | { type: 'setOutput'; output: number }
  | { type: 'setMode'; mode: MonitorMode }
  | { type: 'selectSnapshot'; snapshot: SnapshotId }
  | { type: 'copySnapshot' }
  | { type: 'focus'; id: string }
  | { type: 'applyPreset'; board: InstantiatedPreset; name: string }
  | { type: 'applyAgent'; board: ToneAgentBoardState; replaceSnapshots: boolean }
  | { type: 'rename'; name: string }
  | { type: 'restore'; state: BoardUiState };

export function cloneValues(values: Values) {
  return Object.fromEntries(Object.entries(values).map(([id, controls]) => [id, { ...controls }]));
}

export function cloneBoardUiState(state: BoardUiState): BoardUiState {
  return {
    chain: state.chain.map((item) => ({ ...item })),
    snapshots: { A: cloneValues(state.snapshots.A), B: cloneValues(state.snapshots.B) },
    snapshot: state.snapshot,
    selected: state.selected,
    bypassed: new Set(state.bypassed),
    source: { ...state.source },
    routing: { ...state.routing },
    amp: { ...state.amp, ampValues: { ...state.amp.ampValues }, cabValues: { ...state.amp.cabValues } },
    output: state.output,
    mode: state.mode,
    activePresetName: state.activePresetName,
  };
}

/** Both snapshots start as the preset; B diverges only when the player edits it. */
export function makeSnapshots(board: InstantiatedPreset) {
  return { A: cloneValues(board.values), B: cloneValues(board.values) };
}

export function boardFromPreset(board: InstantiatedPreset, name: string, mode: MonitorMode = 'wet'): BoardUiState {
  return {
    chain: board.chain.map((item) => ({ ...item })),
    snapshots: makeSnapshots(board),
    snapshot: 'A',
    selected: board.selectedInstanceId && board.chain.some((item) => item.instanceId === board.selectedInstanceId)
      ? board.selectedInstanceId
      : board.chain[0]?.instanceId ?? RIG_NODE,
    bypassed: new Set(board.bypassed),
    source: { ...board.source },
    routing: { ...board.routing },
    amp: { ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } },
    output: board.output,
    mode,
    activePresetName: name,
  };
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
      if (state.chain.length >= MAX_PEDALS || state.chain.some((item) => item.instanceId === action.instanceId)) return state;
      const lane = state.routing.mode === 'parallel' ? action.lane : 'A';
      const item: ChainItem = { instanceId: action.instanceId, specId: action.specId, lane };
      const defaults = makeDefaultValues(action.specId);
      return edited(state, {
        chain: insertAt(state.chain, item, state.routing.mode, lane, action.index),
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
      return edited(state, { chain: insertAt(rest, { ...moving, lane }, mode, lane, index) });
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
      if (!state.chain.some((item) => item.instanceId === action.instanceId)) return state;
      const order = nodeOrder(state);
      const at = order.indexOf(action.instanceId);
      const chain = state.chain.filter((item) => item.instanceId !== action.instanceId);
      const neighbour = [order[at - 1], order[at + 1]].find((id) => id && chain.some((item) => item.instanceId === id));
      const bypassed = new Set(state.bypassed);
      bypassed.delete(action.instanceId);
      return edited(state, {
        chain,
        snapshots: { A: withoutInstance(state.snapshots.A, action.instanceId), B: withoutInstance(state.snapshots.B, action.instanceId) },
        bypassed,
        selected: state.selected === action.instanceId ? neighbour ?? RIG_NODE : state.selected,
      });
    }
    case 'bypass': {
      if (!state.chain.some((item) => item.instanceId === action.instanceId)) return state;
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
      return edited(state, { routing });
    }
    case 'setSource':
      return edited(state, { source: action.source });
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
  return {
    chain: board.chain.map((item) => ({ ...item })),
    snapshots,
    snapshot: replaceSnapshots ? 'A' : state.snapshot,
    selected: board.chain[0]?.instanceId ?? RIG_NODE,
    bypassed: new Set(board.bypassed),
    source: { ...board.source },
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
    case 'setRouting':
      return action.routing.mode === undefined ? `routing:${Object.keys(action.routing).sort().join(',')}` : 'discrete';
    case 'add':
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
