'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import type { SignalLane } from '../audio/audio-core.ts';
import { getAmpSpec, getCabSpec } from '../amps/catalog.ts';
import { getEffectSpec } from '../effects/catalog.ts';
import { engineChip, type BoardNodeProps } from './Board.tsx';
import { laneItems, laneOf, MIXER_NODE, RIG_NODE, type ChainItem } from './board-store.ts';
import { categoryNames, MiniPedal } from './studio-shared.tsx';

type Drag = { id: string; pointerId: number; startY: number; y: number; target: { lane: SignalLane; slot: number } | null };

const LONG_PRESS_MS = 380;
const MOVE_TOLERANCE_PX = 8;

/**
 * Phones: the signal flow as a vertical list, input at the top and the amp at
 * the bottom. Tap a row to open its deck; drag the handle (or long-press the
 * row) to reorder; the + rows insert at that spot.
 */
export function FlowList(props: BoardNodeProps) {
  const { state, deckOpen, lit, sourceLabel, engineStatus, namLoaded, onOpenNode, onBypass, onInsert, onMove, onOpenInput, onConnectParked } = props;
  const parallel = state.routing.mode === 'parallel';
  const root = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<{ id: string; pointerId: number; x: number; y: number; timer: number } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => { dragRef.current = drag; }, [drag]);

  // While dragging, stop the page from scrolling under the finger.
  useEffect(() => {
    if (!drag) return;
    const block = (event: TouchEvent) => event.preventDefault();
    document.addEventListener('touchmove', block, { passive: false });
    return () => document.removeEventListener('touchmove', block);
  }, [drag]);

  function nearestSlot(id: string, y: number) {
    const moving = state.chain.find((item) => item.instanceId === id);
    if (!moving || !root.current) return null;
    let best: { lane: SignalLane; slot: number } | null = null;
    let bestDistance = Infinity;
    root.current.querySelectorAll<HTMLElement>('[data-flow-slot-lane]').forEach((element) => {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { lane: element.dataset.flowSlotLane as SignalLane, slot: Number(element.dataset.flowSlotIndex) };
      }
    });
    if (!best) return null;
    const target: { lane: SignalLane; slot: number } = best;
    const row = laneItems(state.chain, state.routing.mode, target.lane);
    const from = row.indexOf(moving);
    if ((!parallel || laneOf(moving) === target.lane) && (target.slot === from || target.slot === from + 1)) return null;
    return target;
  }

  function beginDrag(id: string, pointerId: number, y: number) {
    navigator.vibrate?.(12);
    setDrag({ id, pointerId, startY: y, y, target: null });
  }

  function onHandleDown(id: string) {
    return (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      beginDrag(id, event.pointerId, event.clientY);
    };
  }

  function onRowDown(id: string) {
    return (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'mouse') return;
      const pointerId = event.pointerId;
      const x = event.clientX;
      const y = event.clientY;
      const element = event.currentTarget;
      press.current = {
        id, pointerId, x, y,
        timer: window.setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          try { element.setPointerCapture(pointerId); } catch { /* the pointer already ended */ }
          beginDrag(id, pointerId, y);
        }, LONG_PRESS_MS),
      };
    };
  }

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (press.current && press.current.pointerId === event.pointerId && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > MOVE_TOLERANCE_PX) cancelPress();
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setDrag({ ...current, y: event.clientY, target: nearestSlot(current.id, event.clientY) });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    cancelPress();
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setDrag(null);
    if (current.target) onMove(current.id, current.target.lane, current.target.slot);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  }

  function onPointerCancel() {
    cancelPress();
    setDrag(null);
    suppressClick.current = false;
  }

  const insertRow = (lane: SignalLane, index: number, count: number) => (
    <li className={'flow-slot' + (drag?.target?.lane === lane && drag.target.slot === index ? ' is-target' : '')} data-flow-slot-lane={lane} data-flow-slot-index={index} key={`slot-${lane}-${index}`}>
      <button type="button" aria-label={`在${parallel ? `${lane} 路` : ''}第 ${index + 1} 位插入效果器`} onClick={() => onInsert(lane, index)}>
        <span aria-hidden="true">+</span>{index === count ? (count === 0 ? '添加效果器' : '添加到这里') : ''}
      </button>
    </li>
  );

  const pedalRow = (item: ChainItem, position: number) => {
    const spec = getEffectSpec(item.specId);
    const bypassed = state.bypassed.has(item.instanceId);
    const chip = engineChip(spec, engineStatus(item.instanceId), namLoaded(spec));
    const dragging = drag?.id === item.instanceId;
    const style = dragging ? ({ '--drag-y': `${drag.y - drag.startY}px` } as CSSProperties) : undefined;
    return (
      <li className={'flow-row' + (state.selected === item.instanceId ? ' is-selected' : '') + (bypassed ? ' is-bypassed' : '') + (dragging ? ' is-dragging' : '')} style={style} key={item.instanceId}>
        <button
          type="button"
          className="flow-open"
          data-node-id={item.instanceId}
          aria-label={`${position + 1}. ${spec.name}${bypassed ? '，已旁通' : ''}。打开面板`}
          aria-current={state.selected === item.instanceId ? 'true' : undefined}
          aria-expanded={deckOpen && state.selected === item.instanceId}
          aria-controls="focus-deck"
          onPointerDown={onRowDown(item.instanceId)}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => { if (!suppressClick.current) onOpenNode(item.instanceId, event.detail === 0); }}
        >
          <MiniPedal spec={spec} />
          <span className="flow-text">
            <strong>{spec.name}</strong>
            <small>{categoryNames[spec.category]}，{spec.family}</small>
          </span>
          {chip && <span className={'engine-chip ' + chip.tone}>{chip.text}</span>}
        </button>
        <button type="button" role="switch" aria-checked={!bypassed} aria-label={(bypassed ? '启用' : '旁通') + spec.name} className={'flow-bypass' + (bypassed ? '' : ' is-on')} style={{ '--accent': spec.accent } as CSSProperties} onClick={() => onBypass(item.instanceId)}>
          <i aria-hidden="true" />
        </button>
        <span className="flow-handle" aria-hidden="true" onPointerDown={onHandleDown(item.instanceId)}><i /><i /><i /></span>
      </li>
    );
  };

  const ampSpec = getAmpSpec(state.amp.ampId);
  const cabSpec = getCabSpec(state.amp.cabId);
  const combo = ampSpec.format === 'combo' && ampSpec.speakerCab === cabSpec.id;
  const allPedals = parallel ? [...laneItems(state.chain, 'parallel', 'A'), ...laneItems(state.chain, 'parallel', 'B')] : state.chain;
  const positionOf = (item: ChainItem) => allPedals.indexOf(item);

  return (
    <div ref={root} className={'flow-list' + (drag ? ' is-dragging' : '')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <button type="button" className="flow-node flow-input" aria-label={`输入：${sourceLabel}。更换输入`} onClick={onOpenInput}>
        <span className="flow-glyph" aria-hidden="true">⏚</span>
        <span className="flow-text"><strong>输入</strong><small>{sourceLabel}</small></span>
      </button>
      {(parallel ? (['A', 'B'] as const) : (['A'] as const)).map((lane) => {
        const items = laneItems(state.chain, state.routing.mode, lane);
        return (
          <section className={'flow-lane' + (parallel ? ' lane-' + lane.toLowerCase() : '')} key={lane} aria-label={parallel ? `${lane} 路` : '效果器链'}>
            {parallel && <h3>{lane} 路</h3>}
            <ol>
              {items.map((item, index) => [insertRow(lane, index, items.length), pedalRow(item, positionOf(item))])}
              {insertRow(lane, items.length, items.length)}
            </ol>
          </section>
        );
      })}
      {state.parked.length > 0 && (
        <section className="flow-lane flow-parked" aria-label="未接入的效果器">
          <h3>未接入（不发声）</h3>
          <ol>
            {state.parked.map((item) => {
              const spec = getEffectSpec(item.specId);
              return (
                <li className={'flow-row is-parked' + (state.selected === item.instanceId ? ' is-selected' : '')} key={item.instanceId}>
                  <button
                    type="button"
                    className="flow-open"
                    data-node-id={item.instanceId}
                    aria-label={`未接入：${spec.name}。打开面板`}
                    aria-expanded={deckOpen && state.selected === item.instanceId}
                    aria-controls="focus-deck"
                    onClick={(event) => onOpenNode(item.instanceId, event.detail === 0)}
                  >
                    <MiniPedal spec={spec} />
                    <span className="flow-text"><strong>{spec.name}</strong><small>在板上，但没有接线</small></span>
                  </button>
                  <button type="button" className="flow-connect" aria-label={`把${spec.name}接到链尾`} onClick={() => onConnectParked(item.instanceId)}>接入</button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      <button
        type="button"
        className={'flow-node flow-mixer' + (state.selected === MIXER_NODE ? ' is-selected' : '')}
        data-node-id={MIXER_NODE}
        aria-label={parallel ? `A/B 混合，平衡 ${state.routing.blend}%。打开面板` : '信号路由：串联。打开面板'}
        aria-expanded={deckOpen && state.selected === MIXER_NODE}
        aria-controls="focus-deck"
        onClick={(event) => onOpenNode(MIXER_NODE, event.detail === 0)}
      >
        <span className="flow-glyph" aria-hidden="true">{parallel ? 'Σ' : '→'}</span>
        <span className="flow-text"><strong>{parallel ? 'A / B 混合' : '路由'}</strong><small>{parallel ? `平衡 ${state.routing.blend}%，宽度 ${state.routing.spread}%` : '串联，点开可改成双路并联'}</small></span>
      </button>
      <button
        type="button"
        className={'flow-node flow-rig' + (state.selected === RIG_NODE ? ' is-selected' : '') + (state.amp.bypassed ? ' is-bypassed' : '') + (lit ? ' is-lit' : '')}
        data-node-id={RIG_NODE}
        style={{ '--amp-plate': ampSpec.finish } as CSSProperties}
        aria-label={`音箱：${ampSpec.name}${combo ? '（单体）' : `，箱体 ${cabSpec.name}`}${state.amp.bypassed ? '，已旁通' : ''}。打开音箱面板`}
        aria-expanded={deckOpen && state.selected === RIG_NODE}
        aria-controls="focus-deck"
        onClick={(event) => onOpenNode(RIG_NODE, event.detail === 0)}
      >
        <span className="flow-amp" aria-hidden="true"><i className="rig-lamp" /></span>
        <span className="flow-text"><strong>{ampSpec.name}</strong><small>{combo ? '单体音箱' : cabSpec.name}{state.amp.bypassed ? '，已旁通' : ''}</small></span>
      </button>
    </div>
  );
}
