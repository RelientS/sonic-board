'use client';

import { useCallback, useRef, useState } from 'react';

import { BoardHistory } from '../board-history.ts';
import { boardReducer, undoKeyFor, type BoardAction, type BoardUiState } from './board-store.ts';

/**
 * The board store: state, a dispatch that records undo for edits, and undo /
 * redo. The latest state is kept in a ref so several dispatches in one event
 * (or a dispatch right after another) always build on each other.
 */
export function useBoard(initial: () => BoardUiState) {
  const [state, setState] = useState(initial);
  const latest = useRef(state);
  const history = useRef(new BoardHistory<BoardUiState>());
  // Bumped by every change except focus: the tone agent uses it to reject
  // results computed against a board that has since been edited.
  const revision = useRef(0);
  const discreteSerial = useRef(0);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });

  const syncHistoryState = useCallback(() => {
    setHistoryState({ canUndo: history.current.canUndo, canRedo: history.current.canRedo });
  }, []);

  const commit = useCallback((next: BoardUiState, focusOnly: boolean) => {
    if (!focusOnly) revision.current += 1;
    latest.current = next;
    setState(next);
  }, []);

  /** Applies an action; returns false when it changed nothing. */
  const dispatch = useCallback((action: BoardAction) => {
    const previous = latest.current;
    const next = boardReducer(previous, action);
    if (next === previous) return false;
    const key = undoKeyFor(action);
    if (key) {
      history.current.record(previous, performance.now(), key === 'discrete' ? `discrete:${++discreteSerial.current}` : key);
      syncHistoryState();
    }
    commit(next, action.type === 'focus');
    return true;
  }, [commit, syncHistoryState]);

  const undo = useCallback(() => {
    const previous = history.current.undo(latest.current);
    if (!previous) return false;
    commit(previous, false);
    syncHistoryState();
    return true;
  }, [commit, syncHistoryState]);

  const redo = useCallback(() => {
    const next = history.current.redo(latest.current);
    if (!next) return false;
    commit(next, false);
    syncHistoryState();
    return true;
  }, [commit, syncHistoryState]);

  return { state, latest, dispatch, undo, redo, revision, historyState };
}

export type BoardStore = ReturnType<typeof useBoard>;
