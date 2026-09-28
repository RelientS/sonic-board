'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import type { SignalLane } from '../audio/audio-core.ts';
import type { EffectStatus } from '../audio/audio-engine.ts';
import { CIRCUIT_EFFECT_IDS } from '../audio/audio-engine.ts';
import { getAmpSpec, getCabSpec } from '../amps/catalog.ts';
import { getEffectSpec, type EffectSpec } from '../effects/catalog.ts';
import { getPedalControlLabel } from '../effects/control-labels.ts';
import { laneItems, laneOf, MIXER_NODE, RIG_NODE, type BoardUiState, type ChainItem, type Values } from './board-store.ts';
import { layoutParallel, layoutSerial, NODE, type BoardLayout } from './board-layout.ts';
import { knobAngle } from './Knob.tsx';
import { RigObject } from './Rig.tsx';
import { isWidePedal, MiniPedal } from './studio-shared.tsx';

export type BoardNodeProps = {
  state: BoardUiState;
  values: Values;
  deckOpen: boolean;
  lit: boolean;
  sourceLabel: string;
  engineStatus: (instanceId: string) => EffectStatus | undefined;
  namLoaded: (spec: EffectSpec) => boolean;
  /** `fromKeyboard`: move focus into the deck (Enter/Space on the node). */
  onOpenNode: (id: string, fromKeyboard?: boolean) => void;
  onBypass: (instanceId: string) => void;
  onInsert: (lane: SignalLane, index: number) => void;
  onMove: (instanceId: string, lane: SignalLane, slot: number) => void;
  onOpenInput: () => void;
};

type DropTarget = { lane: SignalLane; slot: number };
type DragState = { id: string; x: number; y: number; target: DropTarget | null };

const DRAG_THRESHOLD_PX = 6;

function laneName(lane: SignalLane, parallel: boolean) {
  return parallel ? `${lane} 路` : '';
}

/** Status chip for a pedal: circuit engine, NAM model or a degraded engine. */
export function engineChip(spec: EffectSpec, status: EffectStatus | undefined, namLoaded: boolean) {
  if (spec.nam) return { tone: namLoaded ? 'loaded' : 'missing', text: namLoaded ? '本机 NAM' : '缺少 NAM 模型' };
  if (status === 'passthrough') return { tone: 'missing', text: '直通 · 引擎未加载', title: '该效果的音频引擎没有加载，当前为直通' };
  if (status === 'fallback') return { tone: 'missing', text: 'FALLBACK', title: '电路求解出错，已自动切回干声' };
  if (CIRCUIT_EFFECT_IDS.has(spec.id)) return { tone: 'loaded', text: 'CIRCUIT', title: '按原理图逐元件实时求解' };
  return null;
}

/** The pedal art on the board. Knobs are display-only; editing happens in the deck. */
function PedalArt({ spec, values }: { spec: EffectSpec; values: Record<string, number> }) {
  const controls = spec.controls;
  const columns = controls.length >= 7 ? 4 : controls.length === 4 ? 2 : Math.min(3, Math.max(1, controls.length));
  const style = { '--finish': spec.finish, '--ink': spec.ink, '--accent': spec.accent, '--knob-columns': columns } as CSSProperties;
  return (
    <span className="pedal-shell" style={style}>
      <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
      <span className="jack jack-left" /><span className="jack jack-right" />
      <span className="pedal-maker">{spec.maker}</span>
      <span className="knob-faces">
        {controls.map((control) => {
          const value = values[control.id] ?? control.defaultValue;
          return (
            <span className={'knob-face' + (control.options ? ' is-switch' : '')} key={control.id}>
              {control.options
                ? <span className={'switch-face' + (value >= 50 ? ' is-on' : '')} />
                : <span className="knob" style={{ '--angle': knobAngle(value) } as CSSProperties}><span /></span>}
              <small>{getPedalControlLabel(spec.id, control.id)}</small>
            </span>
          );
        })}
      </span>
      <strong className="pedal-name">{spec.name}</strong>
    </span>
  );
}

function PedalNode({ item, index, values, selected, expanded, bypassed, dragging, chip, onOpen, onBypass, onPointerDown }: {
  item: ChainItem;
  index: number;
  values: Record<string, number>;
  selected: boolean;
  expanded: boolean;
  bypassed: boolean;
  dragging: boolean;
  chip: ReturnType<typeof engineChip>;
  onOpen: (fromKeyboard: boolean) => void;
  onBypass: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const spec = getEffectSpec(item.specId);
  return (
    <div className={'pedal-node' + (isWidePedal(spec) ? ' is-wide' : '') + (selected ? ' is-selected' : '') + (bypassed ? ' is-bypassed' : '') + (dragging ? ' is-dragging' : '')}>
      <button
        type="button"
        className="pedal-face"
        data-node-id={item.instanceId}
        aria-label={`${index + 1}. ${spec.name}${bypassed ? '，已旁通' : ''}。打开面板`}
        aria-current={selected ? 'true' : undefined}
        aria-expanded={expanded}
        aria-controls="focus-deck"
        onClick={(event) => onOpen(event.detail === 0)}
        onPointerDown={onPointerDown}
      >
        <PedalArt spec={spec} values={values} />
        {chip && <span className={'engine-chip ' + chip.tone} title={chip.title}>{chip.text}</span>}
      </button>
      <span className="order-badge" aria-hidden="true">{index + 1}</span>
      <button
        type="button"
        className="footswitch"
        aria-label={(bypassed ? '启用' : '旁通') + spec.name}
        aria-pressed={!bypassed}
        onClick={onBypass}
      >
        <span className={'led' + (bypassed ? '' : ' on')} style={{ '--accent': spec.accent } as CSSProperties} aria-hidden="true" />
        <span className="metal-switch" aria-hidden="true" />
      </button>
    </div>
  );
}

function Slot({ lane, index, parallel, target, onInsert }: { lane: SignalLane; index: number; parallel: boolean; target: boolean; onInsert: () => void }) {
  return (
    <span className={'slot' + (target ? ' is-target' : '')} data-slot-lane={lane} data-slot-index={index}>
      <span className="slot-cable" aria-hidden="true" />
      <button type="button" className="slot-add" aria-label={`在${laneName(lane, parallel)}第 ${index + 1} 位插入效果器`} onClick={onInsert}>+</button>
    </span>
  );
}

function useStageSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 1200, height: 520 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The stage's padding is not available to the board.
    const measure = () => {
      const style = getComputedStyle(element);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setSize({ width: element.clientWidth - padX, height: element.clientHeight - padY });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function widthOf(item: ChainItem) {
  return isWidePedal(getEffectSpec(item.specId)) ? NODE.widePedal : NODE.pedal;
}

/**
 * Desktop board: the signal chain drawn left to right, scaled to fit, split
 * into snaking tiers when long; in parallel mode two lanes between a splitter
 * and the mixer. Pedals are reordered by dragging them onto a slot.
 */
export function Board(props: BoardNodeProps) {
  const { state, values, deckOpen, lit, sourceLabel, engineStatus, namLoaded, onOpenNode, onBypass, onInsert, onMove, onOpenInput } = props;
  const stage = useRef<HTMLDivElement | null>(null);
  const size = useStageSize(stage);
  const parallel = state.routing.mode === 'parallel';
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ id: string; pointerId: number; x: number; y: number; started: boolean } | null>(null);
  const suppressClick = useRef(false);

  const laneA = laneItems(state.chain, state.routing.mode, 'A');
  const laneB = parallel ? laneItems(state.chain, 'parallel', 'B') : [];
  const layout: BoardLayout = parallel
    ? layoutParallel(laneA.map(widthOf), laneB.map(widthOf), size.width, size.height)
    : layoutSerial(state.chain.map(widthOf), size.width, size.height);
  const indexOf = (id: string) => [...laneA, ...laneB].findIndex((item) => item.instanceId === id);

  // Escape cancels a drag.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      pending.current = null;
      setDrag(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  function nearestSlot(id: string, x: number, y: number): DropTarget | null {
    const root = stage.current;
    if (!root) return null;
    const moving = state.chain.find((item) => item.instanceId === id);
    if (!moving) return null;
    let best: DropTarget | null = null;
    let bestDistance = Infinity;
    root.querySelectorAll<HTMLElement>('[data-slot-lane]').forEach((element) => {
      const rect = element.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const distance = dx * dx + dy * dy * 4;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { lane: element.dataset.slotLane as SignalLane, slot: Number(element.dataset.slotIndex) };
      }
    });
    if (!best) return null;
    const target: DropTarget = best;
    // Dropping next to where the pedal already is changes nothing.
    const row = laneItems(state.chain, state.routing.mode, target.lane);
    const from = row.indexOf(moving);
    const sameRow = !parallel || laneOf(moving) === target.lane;
    if (sameRow && (target.slot === from || target.slot === from + 1)) return null;
    return target;
  }

  function pedalPointerDown(id: string) {
    return (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      pending.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = pending.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.started) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD_PX) return;
      current.started = true;
    }
    setDrag({ id: current.id, x: event.clientX, y: event.clientY, target: nearestSlot(current.id, event.clientX, event.clientY) });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = pending.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pending.current = null;
    if (!current.started) return;
    // The button's click follows pointerup: a drag is not a click.
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    const target = drag?.id === current.id ? drag.target : null;
    setDrag(null);
    if (target) onMove(current.id, target.lane, target.slot);
  }

  function onPointerCancel() {
    pending.current = null;
    setDrag(null);
  }

  const renderPedal = (item: ChainItem) => {
    const spec = getEffectSpec(item.specId);
    return (
      <PedalNode
        key={item.instanceId}
        item={item}
        index={indexOf(item.instanceId)}
        values={values[item.instanceId] ?? {}}
        selected={state.selected === item.instanceId}
        expanded={deckOpen && state.selected === item.instanceId}
        bypassed={state.bypassed.has(item.instanceId)}
        dragging={drag?.id === item.instanceId}
        chip={engineChip(spec, engineStatus(item.instanceId), namLoaded(spec))}
        onOpen={(fromKeyboard) => { if (!suppressClick.current) onOpenNode(item.instanceId, fromKeyboard); }}
        onBypass={() => onBypass(item.instanceId)}
        onPointerDown={pedalPointerDown(item.instanceId)}
      />
    );
  };

  const slot = (lane: SignalLane, index: number) => (
    <Slot
      key={`slot-${lane}-${index}`}
      lane={lane}
      index={index}
      parallel={parallel}
      target={drag?.target?.lane === lane && drag.target.slot === index}
      onInsert={() => onInsert(lane, index)}
    />
  );

  const inputNode = (
    <button type="button" className="input-node" aria-label={`输入：${sourceLabel}。更换输入`} onClick={onOpenInput}>
      <span className="jack-plate" aria-hidden="true"><i /></span>
      <small>输入</small>
    </button>
  );

  const junction = (
    <button
      type="button"
      className={'junction-node' + (state.selected === MIXER_NODE ? ' is-selected' : '')}
      data-node-id={MIXER_NODE}
      aria-label={parallel ? `A/B 混合，平衡 ${state.routing.blend}%。打开面板` : '信号路由：串联。打开面板'}
      aria-current={state.selected === MIXER_NODE ? 'true' : undefined}
      aria-expanded={deckOpen && state.selected === MIXER_NODE}
      aria-controls="focus-deck"
      onClick={(event) => onOpenNode(MIXER_NODE, event.detail === 0)}
    >
      <strong>{parallel ? 'Σ' : '→'}</strong>
      <small>{parallel ? '混合' : '路由'}</small>
    </button>
  );

  const ampSpec = getAmpSpec(state.amp.ampId);
  const cabSpec = getCabSpec(state.amp.cabId);
  const rig = (
    <RigObject
      nodeId={RIG_NODE}
      amp={ampSpec}
      cab={cabSpec}
      bypassed={state.amp.bypassed}
      lit={lit}
      selected={state.selected === RIG_NODE}
      expanded={deckOpen && state.selected === RIG_NODE}
      onOpen={(fromKeyboard) => onOpenNode(RIG_NODE, fromKeyboard)}
    />
  );

  const ghostSpec = drag ? getEffectSpec(state.chain.find((item) => item.instanceId === drag.id)?.specId ?? state.chain[0]?.specId) : null;

  return (
    <div
      ref={stage}
      className={'board-stage' + (drag ? ' is-dragging' : '')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="board-surface" style={{ width: layout.width * layout.scale, height: layout.height * layout.scale }}>
        <div className="board-zoom" style={{ zoom: layout.scale, width: layout.width, height: layout.height } as CSSProperties}>
          {layout.mode === 'serial' ? (
            <div className={'tiers' + (layout.rows.length > 1 ? ' has-bends' : '') + (state.chain.length === 0 ? ' is-empty' : '')} style={{ '--row-h': `${NODE.rowHeight}px`, '--row-gap': `${NODE.rowGap}px`, '--bend': `${NODE.bend}px` } as CSSProperties}>
              {layout.rows.map((row, tier) => {
                const first = tier === 0;
                const last = tier === layout.rows.length - 1;
                return (
                  <div className={'tier' + (tier % 2 ? ' is-reverse' : '')} key={tier}>
                    {first && inputNode}
                    {row.map((pedalIndex) => [slot('A', pedalIndex), renderPedal(state.chain[pedalIndex])])}
                    {last && <>{slot('A', state.chain.length)}{junction}<span className="slot-cable is-fixed" aria-hidden="true" />{rig}</>}
                  </div>
                );
              })}
              {layout.rows.slice(1).map((_, gap) => (
                <span
                  key={`bend-${gap}`}
                  className={'tier-bend ' + (gap % 2 ? 'left' : 'right')}
                  style={{ top: NODE.padY + gap * (NODE.rowHeight + NODE.rowGap) + NODE.rowHeight / 2 }}
                  aria-hidden="true"
                />
              ))}
              {state.chain.length === 0 && <p className="board-empty">点 <b>+</b> 或按 ⌘/Ctrl + K 添加第一块效果器。</p>}
            </div>
          ) : (
            <div className="parallel-board">
              {inputNode}
              <span className="slot-cable is-fixed" aria-hidden="true" />
              <span className="splitter-node" aria-hidden="true"><small>分流</small></span>
              <div className="lanes">
                {(['A', 'B'] as const).map((lane) => {
                  const items = lane === 'A' ? laneA : laneB;
                  return (
                    <div className={'lane lane-' + lane.toLowerCase()} key={lane}>
                      <span className="lane-label">{lane}</span>
                      {items.map((item, index) => [slot(lane, index), renderPedal(item)])}
                      {slot(lane, items.length)}
                      {items.length === 0 && <span className="lane-empty">空通道，干声直通</span>}
                    </div>
                  );
                })}
              </div>
              {junction}
              <span className="slot-cable is-fixed" aria-hidden="true" />
              {rig}
            </div>
          )}
        </div>
      </div>
      {drag && ghostSpec && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          <MiniPedal spec={ghostSpec} />
          <span>{ghostSpec.name}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{drag ? (drag.target ? `放到${laneName(drag.target.lane, parallel)}第 ${drag.target.slot + 1} 位` : '拖到两块之间的位置') : ''}</p>
    </div>
  );
}
