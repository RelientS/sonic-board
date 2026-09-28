/**
 * Fits the chain on the stage without horizontal scrolling: pick the scale
 * and, for a long serial chain, split it over two or three tiers that snake
 * like a real two-tier pedalboard (tier 2 runs right to left).
 * All sizes are in board units (px at scale 1).
 */
export const NODE = {
  input: 64,
  pedal: 136,
  widePedal: 188,
  slot: 36,
  junction: 84,
  rig: 262,
  splitter: 56,
  laneLabel: 44,
  rowHeight: 292,
  rowGap: 64,
  bend: 44,
  padX: 22,
  padY: 40,
  /** The board frame's border on both sides. */
  frame: 20,
  /** Lanes' own padding plus each lane's inner padding (parallel). */
  lanePad: 60,
} as const;

/** Scale below which a chain moves to one more tier. */
const COMFORTABLE_SCALE = 0.8;
const MAX_SCALE = 1.08;
const MIN_SCALE = 0.42;

export type BoardLayout =
  | { mode: 'serial'; rows: number[][]; scale: number; width: number; height: number }
  | { mode: 'parallel'; scale: number; width: number; height: number };

function serialRowWidth(widths: number[], row: number[], first: boolean, last: boolean) {
  let width = row.reduce((sum, index) => sum + widths[index] + NODE.slot, 0);
  if (first) width += NODE.input;
  // The last tier ends: slot, mixer, a fixed cable, then the rig.
  if (last) width += NODE.slot * 2 + NODE.junction + NODE.rig;
  return width;
}

/** Contiguous split of `count` pedals into `tiers` rows with the narrowest widest row. */
function splitRows(widths: number[], tiers: number) {
  const count = widths.length;
  const indices = widths.map((_, index) => index);
  if (tiers === 1 || count < tiers) return [indices];
  let best: number[][] = [indices];
  let bestWidth = Infinity;
  const consider = (rows: number[][]) => {
    const widest = Math.max(...rows.map((row, at) => serialRowWidth(widths, row, at === 0, at === rows.length - 1)));
    if (widest < bestWidth) {
      bestWidth = widest;
      best = rows;
    }
  };
  for (let a = 1; a < count; a += 1) {
    if (tiers === 2) {
      consider([indices.slice(0, a), indices.slice(a)]);
      continue;
    }
    for (let b = a + 1; b < count; b += 1) consider([indices.slice(0, a), indices.slice(a, b), indices.slice(b)]);
  }
  return best;
}

export function layoutSerial(pedalWidths: number[], availableWidth: number, availableHeight: number): BoardLayout {
  let chosen: BoardLayout | null = null;
  for (let tiers = 1; tiers <= 3; tiers += 1) {
    if (tiers > 1 && pedalWidths.length < tiers + 1) break;
    const rows = splitRows(pedalWidths, tiers);
    const widest = Math.max(...rows.map((row, at) => serialRowWidth(pedalWidths, row, at === 0, at === rows.length - 1)));
    const width = widest + NODE.padX * 2 + NODE.frame + (rows.length > 1 ? NODE.bend * 2 : 0);
    const height = rows.length * NODE.rowHeight + (rows.length - 1) * NODE.rowGap + NODE.padY * 2 + NODE.frame;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, availableWidth / width, availableHeight / height));
    const layout: BoardLayout = { mode: 'serial', rows, scale, width, height };
    if (!chosen || scale > chosen.scale + 0.04) chosen = layout;
    if (scale >= COMFORTABLE_SCALE) break;
  }
  return chosen!;
}

export function laneWidth(pedalWidths: number[]) {
  return NODE.laneLabel + pedalWidths.reduce((sum, width) => sum + width + NODE.slot, 0) + NODE.slot;
}

export function layoutParallel(laneA: number[], laneB: number[], availableWidth: number, availableHeight: number): BoardLayout {
  const lanes = Math.max(laneWidth(laneA), laneWidth(laneB), 260) + NODE.lanePad;
  const width = NODE.input + NODE.splitter + NODE.slot * 2 + lanes + NODE.junction + NODE.rig + NODE.padX * 2 + NODE.frame;
  const height = NODE.rowHeight * 2 + NODE.rowGap + NODE.padY * 2 + NODE.frame;
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, availableWidth / width, availableHeight / height));
  return { mode: 'parallel', scale, width, height };
}
