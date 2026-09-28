/**
 * The board's patch: which jack is cabled to which. The audio chain is not
 * stored separately; it is the path the signal takes from the INPUT jack to
 * the OUTPUT jack, and pedals off that path are parked (on the board, silent).
 *
 * Jacks: every pedal has `in` (left) and `out` (right). The guitar INPUT has
 * `out`, the OUTPUT to the rig has `in`. In parallel mode there is a splitter
 * (`in` -> `outA`/`outB`) and a mixer (`inA`/`inB` -> `out`); the engine runs
 * exactly one split and merge with nothing before or after them, so the
 * INPUT must feed the splitter and the mixer must feed the OUTPUT directly.
 */
import type { AudioChainItem, RoutingMode, SignalLane } from '../audio/audio-core.ts';

export const INPUT_NODE = 'input';
export const OUTPUT_NODE = 'output';
export const SPLITTER_NODE = 'splitter';
export const MIXER_NODE = 'mixer';

export type SourcePort = 'out' | 'outA' | 'outB';
export type SinkPort = 'in' | 'inA' | 'inB';
export type Port = SourcePort | SinkPort;
export type JackRef = { node: string; port: Port };
/** A cable always runs from a source jack (`from`) to a sink jack (`to`). */
export type Cable = { from: { node: string; port: SourcePort }; to: { node: string; port: SinkPort } };
export type Point = { x: number; y: number };
export type PatchDoc = { positions: Record<string, Point>; cables: Cable[] };

export type PatchFailure = 'same-node' | 'same-direction' | 'occupied' | 'cycle' | 'parallel-io' | 'unknown-node';

export const PATCH_FAILURE_TEXT: Record<PatchFailure, string> = {
  'same-node': '不能把一块单块接回它自己。',
  'same-direction': '输出只能接到输入，输入只能接到输出。',
  occupied: '这个插孔已经插着线了，先把那根拔掉。',
  cycle: '这样接会形成回路，信号会绕圈。',
  'parallel-io': '并联时，输入要直接接分流器，混合器要直接接输出。',
  'unknown-node': '找不到这个插孔。',
};

export function isSourcePort(port: Port): port is SourcePort {
  return port === 'out' || port === 'outA' || port === 'outB';
}

export function isUtilityNode(node: string) {
  return node === INPUT_NODE || node === OUTPUT_NODE || node === SPLITTER_NODE || node === MIXER_NODE;
}

/** The jacks a node has, by kind. */
export function portsOf(node: string): Port[] {
  switch (node) {
    case INPUT_NODE: return ['out'];
    case OUTPUT_NODE: return ['in'];
    case SPLITTER_NODE: return ['in', 'outA', 'outB'];
    case MIXER_NODE: return ['inA', 'inB', 'out'];
    default: return ['in', 'out'];
  }
}

export function sameJack(a: JackRef, b: JackRef) {
  return a.node === b.node && a.port === b.port;
}

export function cableAt(cables: Cable[], jack: JackRef) {
  return cables.find((cable) => sameJack(cable.from, jack) || sameJack(cable.to, jack));
}

function outgoing(cables: Cable[], node: string, port: SourcePort = 'out') {
  return cables.find((cable) => cable.from.node === node && cable.from.port === port);
}

function incoming(cables: Cable[], node: string, port: SinkPort = 'in') {
  return cables.find((cable) => cable.to.node === node && cable.to.port === port);
}

/** Nodes reachable downstream of `node` (following every source jack). */
function downstream(cables: Cable[], node: string, seen = new Set<string>()) {
  for (const cable of cables) {
    if (cable.from.node !== node || seen.has(cable.to.node)) continue;
    seen.add(cable.to.node);
    downstream(cables, cable.to.node, seen);
  }
  return seen;
}

/**
 * Connects two jacks (in either order). Refuses a patch the engine could not
 * run: wrong directions, a jack that already holds a cable, a loop, or, in
 * parallel mode, anything between INPUT and the splitter or the mixer and OUTPUT.
 */
export function connect(
  cables: Cable[],
  a: JackRef,
  b: JackRef,
  context: { nodes: Set<string>; mode: RoutingMode },
): { ok: true; cables: Cable[] } | { ok: false; reason: PatchFailure } {
  if (!context.nodes.has(a.node) || !context.nodes.has(b.node)) return { ok: false, reason: 'unknown-node' };
  if (a.node === b.node) return { ok: false, reason: 'same-node' };
  if (isSourcePort(a.port) === isSourcePort(b.port)) return { ok: false, reason: 'same-direction' };
  const from = (isSourcePort(a.port) ? a : b) as Cable['from'];
  const to = (isSourcePort(a.port) ? b : a) as Cable['to'];
  if (!portsOf(from.node).includes(from.port) || !portsOf(to.node).includes(to.port)) return { ok: false, reason: 'unknown-node' };
  if (cableAt(cables, from) || cableAt(cables, to)) return { ok: false, reason: 'occupied' };
  if (context.mode === 'parallel') {
    const inputEnd = from.node === INPUT_NODE || to.node === SPLITTER_NODE;
    const outputEnd = to.node === OUTPUT_NODE || from.node === MIXER_NODE;
    if (inputEnd && !(from.node === INPUT_NODE && to.node === SPLITTER_NODE)) return { ok: false, reason: 'parallel-io' };
    if (outputEnd && !(from.node === MIXER_NODE && to.node === OUTPUT_NODE)) return { ok: false, reason: 'parallel-io' };
  }
  if (to.node === from.node || downstream(cables, to.node).has(from.node)) return { ok: false, reason: 'cycle' };
  return { ok: true, cables: [...cables, { from, to }] };
}

export function disconnect(cables: Cable[], jack: JackRef) {
  return cables.filter((cable) => !sameJack(cable.from, jack) && !sameJack(cable.to, jack));
}

export type DerivedChain = {
  /** Pedals on the signal path, in order, with their lane in parallel mode. */
  chain: AudioChainItem[];
  /** Pedals on the board but off the signal path. */
  parked: string[];
  /** The path from INPUT does not reach OUTPUT (the tail is heard as if it did). */
  broken: boolean;
};

/**
 * Follows the cables from `start` through pedals only. Returns the pedals in
 * order and the jack the path ended on (null for a dangling end).
 */
function walk(cables: Cable[], start: Cable['from'], isPedal: (id: string) => boolean) {
  const pedals: string[] = [];
  const seen = new Set<string>();
  let cable = outgoing(cables, start.node, start.port);
  while (cable) {
    const node = cable.to.node;
    if (!isPedal(node) || seen.has(node)) return { pedals, end: cable.to };
    seen.add(node);
    pedals.push(node);
    cable = outgoing(cables, node);
  }
  return { pedals, end: null as Cable['to'] | null };
}

export function deriveChain(pedals: Array<{ instanceId: string; specId: string }>, cables: Cable[], mode: RoutingMode): DerivedChain {
  const byId = new Map(pedals.map((item) => [item.instanceId, item]));
  const isPedal = (id: string) => byId.has(id);
  const item = (id: string, lane: SignalLane): AudioChainItem => ({ instanceId: id, specId: byId.get(id)!.specId, lane });
  let chain: AudioChainItem[];
  let broken: boolean;
  if (mode === 'serial') {
    const path = walk(cables, { node: INPUT_NODE, port: 'out' }, isPedal);
    chain = path.pedals.map((id) => item(id, 'A'));
    broken = path.end?.node !== OUTPUT_NODE;
  } else {
    const a = walk(cables, { node: SPLITTER_NODE, port: 'outA' }, isPedal);
    const b = walk(cables, { node: SPLITTER_NODE, port: 'outB' }, isPedal);
    chain = [...a.pedals.map((id) => item(id, 'A')), ...b.pedals.map((id) => item(id, 'B'))];
    const feeds = outgoing(cables, INPUT_NODE)?.to.node === SPLITTER_NODE;
    const drains = outgoing(cables, MIXER_NODE)?.to.node === OUTPUT_NODE;
    broken = !feeds || !drains || a.end?.node !== MIXER_NODE || b.end?.node !== MIXER_NODE;
  }
  const onPath = new Set(chain.map((entry) => entry.instanceId));
  return { chain, parked: pedals.filter((entry) => !onPath.has(entry.instanceId)).map((entry) => entry.instanceId), broken };
}

/** The tidy patch for a chain: INPUT -> pedals -> OUTPUT, or through the splitter and mixer. */
export function canonicalCables(chain: AudioChainItem[], mode: RoutingMode): Cable[] {
  const cables: Cable[] = [];
  const link = (from: Cable['from'], to: Cable['to']) => cables.push({ from, to });
  const run = (start: Cable['from'], ids: string[], end: Cable['to']) => {
    let from = start;
    for (const id of ids) {
      link(from, { node: id, port: 'in' });
      from = { node: id, port: 'out' };
    }
    link(from, end);
  };
  if (mode === 'serial') {
    run({ node: INPUT_NODE, port: 'out' }, chain.map((entry) => entry.instanceId), { node: OUTPUT_NODE, port: 'in' });
    return cables;
  }
  link({ node: INPUT_NODE, port: 'out' }, { node: SPLITTER_NODE, port: 'in' });
  run({ node: SPLITTER_NODE, port: 'outA' }, chain.filter((entry) => (entry.lane ?? 'A') === 'A').map((entry) => entry.instanceId), { node: MIXER_NODE, port: 'inA' });
  run({ node: SPLITTER_NODE, port: 'outB' }, chain.filter((entry) => entry.lane === 'B').map((entry) => entry.instanceId), { node: MIXER_NODE, port: 'inB' });
  link({ node: MIXER_NODE, port: 'out' }, { node: OUTPUT_NODE, port: 'in' });
  return cables;
}

/**
 * Re-patches for a new chain order: the chain gets tidy cables; cables among
 * parked pedals (a little side chain the player built) are kept.
 */
export function repatch(cables: Cable[], chain: AudioChainItem[], mode: RoutingMode, parked: Iterable<string>) {
  const parkedSet = new Set(parked);
  const kept = cables.filter((cable) => parkedSet.has(cable.from.node) && parkedSet.has(cable.to.node));
  return [...canonicalCables(chain, mode), ...kept];
}

/** Puts a (cable-free) pedal into an existing cable: from -> pedal -> to. */
export function splice(cables: Cable[], target: Cable, pedal: string) {
  const at = cables.findIndex((cable) => sameJack(cable.from, target.from) && sameJack(cable.to, target.to));
  if (at < 0 || cables.some((cable) => cable.from.node === pedal || cable.to.node === pedal)) return null;
  const next = cables.filter((_, index) => index !== at);
  next.push({ from: target.from, to: { node: pedal, port: 'in' } }, { from: { node: pedal, port: 'out' }, to: target.to });
  return next;
}

/** Removes a node's cables and joins the cable into it to the cable out of it. */
export function heal(cables: Cable[], node: string) {
  const into = incoming(cables, node);
  const outOf = outgoing(cables, node);
  const rest = cables.filter((cable) => cable.from.node !== node && cable.to.node !== node);
  if (into && outOf && into.from.node !== outOf.to.node) rest.push({ from: into.from, to: outOf.to });
  return rest;
}

/** The cable that ends at OUTPUT (serial) or at the mixer input of `lane` (parallel). */
export function chainEndCable(cables: Cable[], mode: RoutingMode, lane: SignalLane) {
  return mode === 'serial'
    ? incoming(cables, OUTPUT_NODE)
    : incoming(cables, MIXER_NODE, lane === 'A' ? 'inA' : 'inB');
}

/** Only keeps cables whose both ends exist. */
export function pruneCables(cables: Cable[], nodes: Set<string>) {
  return cables.filter((cable) => nodes.has(cable.from.node) && nodes.has(cable.to.node));
}
