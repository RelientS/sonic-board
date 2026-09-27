/**
 * Undo/redo stack for board edits. Edits recorded in quick succession (a knob
 * drag sends one change per pixel) coalesce into a single step: the snapshot
 * taken before the first of them is kept and later ones are dropped.
 */
export class BoardHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastRecordAt = Number.NEGATIVE_INFINITY;
  private readonly limit: number;
  private readonly coalesceMs: number;

  constructor(limit = 100, coalesceMs = 600) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
  }

  /** Records the state as it was before an edit made at time `now` (ms). */
  record(before: T, now = performance.now()) {
    const coalesce = now - this.lastRecordAt < this.coalesceMs && this.past.length > 0;
    this.lastRecordAt = now;
    this.future = [];
    if (coalesce) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
  }

  /** Returns the state to restore, or null when there is nothing to undo. */
  undo(current: T) {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    this.lastRecordAt = Number.NEGATIVE_INFINITY;
    return previous;
  }

  redo(current: T) {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.lastRecordAt = Number.NEGATIVE_INFINITY;
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
    this.lastRecordAt = Number.NEGATIVE_INFINITY;
  }
}
