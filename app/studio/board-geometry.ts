/**
 * Board geometry in millimetres: real pedal footprints, where the jacks are,
 * grid snapping, alignment guides, overlap checks, board size and automatic
 * layout. Rendering multiplies by PX_PER_MM and then scales to the stage.
 *
 * Positions are stored in signal space: downstream is +x. The board's flow
 * direction is only a view: 'ltr' draws signal space as is; 'rtl' (the real
 * pedalboard convention: guitar in at the right edge, pedal inputs on their
 * right side, the rig on the left) mirrors it horizontally.
 */
import type { AudioChainItem, RoutingMode } from '../audio/audio-core.ts';
import { getEffectSpec, type EffectSpec } from '../effects/catalog.ts';
import { INPUT_NODE, MIXER_NODE, OUTPUT_NODE, SPLITTER_NODE, type Point, type Port } from './patch-graph.ts';
import { PEDAL_FOOTPRINTS_MM } from './pedal-footprints.ts';

export type FlowDirection = 'ltr' | 'rtl';

export const PX_PER_MM = 1.9;
export const GRID_MM = 5;
export const GAP_MM = 4;
/** Distance within which an edge or centre locks onto a neighbour's. */
export const GUIDE_TOLERANCE_MM = 4;
export const MIN_BOARD = { w: 610, h: 320 } as const;
export const MAX_BOARD = { w: 1600, h: 900 } as const;
/** Room on each side for the INPUT / OUTPUT plates. */
const EDGE_MARGIN = 44;
const TOP_MARGIN = 16;

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const FOOTPRINTS = {
  /** Boss-style compact. */
  compact: { w: 73, h: 129 },
  /** MXR / Dunlop 1590B-style. */
  mxr: { w: 64, h: 111 },
  /** Compact enclosure with a crowded panel (e.g. a 7-band EQ). */
  broad: { w: 100, h: 135 },
  /** Big Muff-style and other wide pedals. */
  wide: { w: 146, h: 178 },
} as const;
export const UTILITY_SIZE: Size = { w: 44, h: 64 };
export const PLATE_SIZE: Size = { w: 22, h: 40 };

export function footprintOfSpec(spec: EffectSpec): Size {
  const measured = PEDAL_FOOTPRINTS_MM[spec.id];
  if (measured) return measured;
  if (spec.wide) return FOOTPRINTS.wide;
  if (spec.controls.length > 4) return FOOTPRINTS.broad;
  if (/mxr|dunlop/i.test(spec.maker)) return FOOTPRINTS.mxr;
  return FOOTPRINTS.compact;
}

export function footprintOf(specId: string): Size {
  return footprintOfSpec(getEffectSpec(specId));
}

export function snap(value: number, grid = GRID_MM) {
  return Math.round(value / grid) * grid;
}

export function rectsOverlap(a: Rect, b: Rect, gap = GAP_MM) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export type Guide = { axis: 'x' | 'y'; at: number; from: number; to: number };

/**
 * Pulls a moving rect onto neighbours' edges and centres when it is within
 * GUIDE_TOLERANCE_MM of them, per axis, and reports the lines it locked to.
 */
export function alignToGuides(moving: Rect, others: Rect[]): { x: number; y: number; guides: Guide[] } {
  const guides: Guide[] = [];
  const pick = (axis: 'x' | 'y') => {
    const size = axis === 'x' ? moving.w : moving.h;
    const start = axis === 'x' ? moving.x : moving.y;
    const lines = [0, size / 2, size];
    let best: { delta: number; at: number; other: Rect } | null = null;
    for (const other of others) {
      const otherStart = axis === 'x' ? other.x : other.y;
      const otherSize = axis === 'x' ? other.w : other.h;
      for (const line of lines) {
        for (const target of [otherStart, otherStart + otherSize / 2, otherStart + otherSize]) {
          const delta = target - (start + line);
          if (Math.abs(delta) <= GUIDE_TOLERANCE_MM && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target, other };
        }
      }
    }
    if (!best) return start;
    const locked = start + best.delta;
    const span = axis === 'x'
      ? { from: Math.min(moving.y, best.other.y), to: Math.max(moving.y + moving.h, best.other.y + best.other.h) }
      : { from: Math.min(moving.x, best.other.x), to: Math.max(moving.x + moving.w, best.other.x + best.other.w) };
    guides.push({ axis, at: best.at, ...span });
    return locked;
  };
  const x = pick('x');
  const y = pick('y');
  return { x, y, guides };
}

/** Top-left bounds a node may occupy (the plates live in the side margins). */
export function clampToBoard(point: Point, size: Size): Point {
  return {
    x: Math.min(MAX_BOARD.w - EDGE_MARGIN - size.w, Math.max(EDGE_MARGIN, point.x)),
    y: Math.min(MAX_BOARD.h - TOP_MARGIN - size.h, Math.max(TOP_MARGIN, point.y)),
  };
}

/**
 * The closest spot to `wanted` (on the grid) where a rect of `size` does not
 * touch any of `others`, searching outward ring by ring. Null if none nearby.
 */
export function nearestFreeSpot(wanted: Point, size: Size, others: Rect[], radius = 400): Point | null {
  const start = clampToBoard({ x: snap(wanted.x), y: snap(wanted.y) }, size);
  const free = (point: Point) => !others.some((other) => rectsOverlap({ ...point, ...size }, other));
  if (free(start)) return start;
  for (let ring = GRID_MM; ring <= radius; ring += GRID_MM) {
    let best: Point | null = null;
    let bestDistance = Infinity;
    for (let dx = -ring; dx <= ring; dx += GRID_MM) {
      for (const dy of Math.abs(dx) === ring ? rangeStep(-ring, ring) : [-ring, ring]) {
        const candidate = clampToBoard({ x: start.x + dx, y: start.y + dy }, size);
        if (!free(candidate)) continue;
        const distance = Math.hypot(candidate.x - wanted.x, candidate.y - wanted.y);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function rangeStep(from: number, to: number) {
  const values: number[] = [];
  for (let value = from; value <= to; value += GRID_MM) values.push(value);
  return values;
}

export type NodeBox = { id: string; rect: Rect };

/** Board size: fits every node plus margins, never smaller than a real board. */
export function boardSize(boxes: Rect[]): Size {
  const right = Math.max(0, ...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(0, ...boxes.map((box) => box.y + box.h));
  return {
    w: Math.min(MAX_BOARD.w, Math.max(MIN_BOARD.w, right + EDGE_MARGIN)),
    h: Math.min(MAX_BOARD.h, Math.max(MIN_BOARD.h, bottom + TOP_MARGIN)),
  };
}

/** The INPUT and OUTPUT plates sit on the board's side edges, vertically centred. */
export function plateRect(node: typeof INPUT_NODE | typeof OUTPUT_NODE, board: Size): Rect {
  const y = board.h / 2 - PLATE_SIZE.h / 2;
  return node === INPUT_NODE ? { x: 8, y, ...PLATE_SIZE } : { x: board.w - 8 - PLATE_SIZE.w, y, ...PLATE_SIZE };
}

/** Where a jack is, in board millimetres. Pedal jacks sit high on the sides. */
export function jackPoint(rect: Rect, node: string, port: Port): Point {
  const left = rect.x;
  const right = rect.x + rect.w;
  if (node === INPUT_NODE || node === OUTPUT_NODE) return { x: node === INPUT_NODE ? right : left, y: rect.y + rect.h / 2 };
  if (node === SPLITTER_NODE) {
    if (port === 'in') return { x: left, y: rect.y + rect.h / 2 };
    return { x: right, y: rect.y + (port === 'outA' ? rect.h * 0.28 : rect.h * 0.72) };
  }
  if (node === MIXER_NODE) {
    if (port === 'out') return { x: right, y: rect.y + rect.h / 2 };
    return { x: left, y: rect.y + (port === 'inA' ? rect.h * 0.28 : rect.h * 0.72) };
  }
  return { x: port === 'in' ? left : right, y: rect.y + 24 };
}

/** Mirrors a signal-space x for the view (identity for 'ltr'). */
export function viewX(x: number, board: Size, direction: FlowDirection) {
  return direction === 'ltr' ? x : board.w - x;
}

/** A rect in view space (for 'rtl' the mirror of its signal-space rect). */
export function viewRect(rect: Rect, board: Size, direction: FlowDirection): Rect {
  return direction === 'ltr' ? rect : { ...rect, x: board.w - rect.x - rect.w };
}

/** Top-left in signal space for a rect whose top-left is `point` in view space. */
export function signalPoint(point: Point, size: Size, board: Size, direction: FlowDirection): Point {
  return direction === 'ltr' ? point : { x: board.w - point.x - size.w, y: point.y };
}

/**
 * A sagging patch cable from a source jack `a` to a sink jack `b` (view
 * space, mm). Each end leaves its jack sideways, downstream for the source.
 */
export function cablePath(a: Point, b: Point, direction: FlowDirection = 'ltr') {
  const sign = direction === 'ltr' ? 1 : -1;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.max(18, Math.min(80, Math.abs(b.x - a.x) * 0.45 + 12));
  const sag = Math.min(46, 8 + span * 0.12);
  return `M ${a.x} ${a.y} C ${a.x + sign * reach} ${a.y + sag}, ${b.x - sign * reach} ${b.y + sag}, ${b.x} ${b.y}`;
}

/** The cable's midpoint (for its '+' button). */
export function cableMidpoint(a: Point, b: Point): Point {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = Math.min(46, 8 + span * 0.12);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag * 0.75 };
}

const ROW_GAP = 26;
const PEDAL_GAP = 16;

/**
 * Lays the board out in signal order: serial chains fill rows left to right
 * and wrap; parallel boards put the splitter left, lane A on the top row,
 * lane B below and the mixer after the longer lane. Parked pedals go last.
 */
export function autoLayout(chain: AudioChainItem[], mode: RoutingMode, parked: Array<{ instanceId: string; specId: string }>): Record<string, Point> {
  const positions: Record<string, Point> = {};
  const rowWidth = MIN_BOARD.w - EDGE_MARGIN * 2;
  let y = TOP_MARGIN + 4;
  const placeRow = (items: Array<{ instanceId: string; specId: string }>, startX: number, wrap: boolean) => {
    let x = startX;
    let rowHeight = 0;
    let right = startX;
    for (const item of items) {
      const size = footprintOf(item.specId);
      if (wrap && x > startX && x + size.w > startX + rowWidth) {
        y += rowHeight + ROW_GAP;
        x = startX;
        rowHeight = 0;
      }
      positions[item.instanceId] = { x: snap(x), y: snap(y) };
      x += size.w + PEDAL_GAP;
      right = Math.max(right, x - PEDAL_GAP);
      rowHeight = Math.max(rowHeight, size.h);
    }
    return { right, rowHeight };
  };
  if (mode === 'serial') {
    const { rowHeight } = placeRow(chain, EDGE_MARGIN + 6, true);
    if (rowHeight) y += rowHeight + ROW_GAP;
  } else {
    const laneA = chain.filter((item) => (item.lane ?? 'A') === 'A');
    const laneB = chain.filter((item) => item.lane === 'B');
    const splitterX = EDGE_MARGIN + 6;
    const laneX = splitterX + UTILITY_SIZE.w + 30;
    const top = y;
    const a = placeRow(laneA, laneX, false);
    const heightA = Math.max(a.rowHeight, FOOTPRINTS.compact.h);
    y = top + heightA + ROW_GAP;
    const b = placeRow(laneB, laneX, false);
    const heightB = Math.max(b.rowHeight, FOOTPRINTS.compact.h);
    const middle = top + (heightA + ROW_GAP + heightB) / 2 - UTILITY_SIZE.h / 2;
    positions[SPLITTER_NODE] = { x: snap(splitterX), y: snap(middle) };
    positions[MIXER_NODE] = { x: snap(Math.max(a.right, b.right, laneX + 60) + 30), y: snap(middle) };
    y += heightB + ROW_GAP;
  }
  if (parked.length) placeRow(parked, EDGE_MARGIN + 6, true);
  return positions;
}
