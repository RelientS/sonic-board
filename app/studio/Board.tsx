'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import type { SignalLane } from '../audio/audio-core.ts';
import type { EffectStatus } from '../audio/audio-engine.ts';
import { CIRCUIT_EFFECT_IDS } from '../audio/audio-engine.ts';
import { getAmpSpec, getCabSpec } from '../amps/catalog.ts';
import { getEffectSpec, type EffectSpec } from '../effects/catalog.ts';
import { getPedalControlLabel } from '../effects/control-labels.ts';
import {
  alignToGuides,
  boardSize,
  cableMidpoint,
  cablePath,
  clampToBoard,
  footprintOf,
  GRID_MM,
  jackPoint,
  nearestFreeSpot,
  plateRect,
  PX_PER_MM,
  rectsOverlap,
  signalPoint,
  snap,
  UTILITY_SIZE,
  viewRect,
  viewX,
  type FlowDirection,
  type Guide,
  type Rect,
  type Size,
} from './board-geometry.ts';
import { MIXER_NODE, occupiedRects, patchBroken, RIG_NODE, type BoardUiState, type ChainItem, type Values } from './board-store.ts';
import { knobAngle } from './Knob.tsx';
import {
  cableAt,
  connect,
  disconnect,
  INPUT_NODE,
  isSourcePort,
  OUTPUT_NODE,
  PATCH_FAILURE_TEXT,
  portsOf,
  SPLITTER_NODE,
  type Cable,
  type JackRef,
  type Point,
} from './patch-graph.ts';
import { RigObject } from './Rig.tsx';

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
  /** Order-based insert (phone list). */
  onInsert: (lane: SignalLane, index: number) => void;
  /** Order-based move (phone list). */
  onMove: (instanceId: string, lane: SignalLane, slot: number) => void;
  onOpenInput: () => void;
  /** Parked pedal onto the end of the chain (phone list, deck). */
  onConnectParked: (instanceId: string) => void;
};

export type FreeBoardProps = BoardNodeProps & {
  direction: FlowDirection;
  /** Optional top-down photos by spec id (owner only); drawn pedals otherwise. */
  skins?: Record<string, string>;
  onPlace: (id: string, x: number, y: number) => void;
  onPatch: (cables: Cable[]) => void;
  onInsertOnCable: (cable: Cable) => void;
  onTidy: () => void;
  onDirectionChange: (direction: FlowDirection) => void;
  onNotice: (message: string) => void;
};

/** Status chip for a pedal: circuit engine, NAM model or a degraded engine. */
export function engineChip(spec: EffectSpec, status: EffectStatus | undefined, namLoaded: boolean) {
  if (spec.nam) return { tone: namLoaded ? 'loaded' : 'missing', text: namLoaded ? 'NAM 已加载' : '缺少 NAM 模型' };
  if (status === 'passthrough') return { tone: 'missing', text: '直通 · 引擎未加载', title: '该效果的音频引擎没有加载，当前为直通' };
  if (status === 'fallback') return { tone: 'missing', text: 'FALLBACK', title: '电路求解出错，已自动切回干声' };
  if (CIRCUIT_EFFECT_IDS.has(spec.id)) return { tone: 'loaded', text: 'CIRCUIT', title: '按原理图逐元件实时求解' };
  return null;
}

/** The drawn pedal. Knobs are display-only; editing happens in the deck. */
function PedalArt({ spec, values }: { spec: EffectSpec; values: Record<string, number> }) {
  const controls = spec.controls;
  const columns = controls.length >= 7 ? 4 : controls.length === 4 ? 2 : Math.min(3, Math.max(1, controls.length));
  const style = { '--finish': spec.finish, '--ink': spec.ink, '--accent': spec.accent, '--knob-columns': columns } as CSSProperties;
  return (
    <span className="pedal-shell" style={style}>
      <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
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

const RIG_W = 270;
const RIG_H = 260;
const RIG_GAP = 56;
const MAX_SCALE = 1.15;
const DRAG_THRESHOLD_PX = 5;
/** Jacks accept a dropped cable end within this distance (mm). */
const JACK_REACH_MM = 16;
const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.2, 1.45, 1.75, 2.1];

/** `frozen`: board size and scale held still while a pedal is dragged. */
type PedalDrag = { id: string; pointerId: number; startX: number; startY: number; offset: Point; size: Size; started: boolean; preview: Point | null; guides: Guide[]; frozen: { board: Size; scale: number } | null };
type CableDrag = { pointerId: number; anchor: JackRef; base: Cable[]; picked: boolean; startX: number; startY: number; started: boolean; end: Point; target: JackRef | null; refused: string };

function useStageSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 1200, height: 520 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
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

function jackLabel(node: string, port: string, name: (id: string) => string) {
  if (node === INPUT_NODE) return '吉他输入';
  if (node === OUTPUT_NODE) return '输出到音箱';
  if (node === SPLITTER_NODE) return port === 'in' ? '分流器输入' : `分流器 ${port === 'outA' ? 'A' : 'B'} 输出`;
  if (node === MIXER_NODE) return port === 'out' ? '混合器输出' : `混合器 ${port === 'inA' ? 'A' : 'B'} 输入`;
  return `${name(node)}${port === 'in' ? '输入' : '输出'}`;
}

/**
 * Desktop board: a real pedalboard. Pedals sit where you put them (real
 * footprints, 5 mm grid, alignment guides, no overlap); patch cables run
 * from jack to jack and the signal chain is whatever path they make from the
 * guitar input to the output. Unplugged pedals are parked and silent.
 */
export function Board(props: FreeBoardProps) {
  const { state, values, deckOpen, lit, sourceLabel, engineStatus, namLoaded, onOpenNode, onBypass, onOpenInput, direction, skins } = props;
  const stage = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stage);
  const parallel = state.routing.mode === 'parallel';
  const [zoom, setZoom] = useState(1);
  const [pedalDrag, setPedalDrag] = useState<PedalDrag | null>(null);
  const [cableDrag, setCableDrag] = useState<CableDrag | null>(null);
  const pedalDragRef = useRef<PedalDrag | null>(null);
  const cableDragRef = useRef<CableDrag | null>(null);
  const suppressClick = useRef(false);

  const pedals: ChainItem[] = useMemo(() => [...state.chain, ...state.parked], [state.chain, state.parked]);
  const parkedIds = useMemo(() => new Set(state.parked.map((item) => item.instanceId)), [state.parked]);
  const positions = state.patch.positions;
  const boxes = occupiedRects(positions, pedals);
  const board = pedalDrag?.frozen?.board ?? boardSize(boxes);
  const boardPx = { w: board.w * PX_PER_MM, h: board.h * PX_PER_MM };
  const totalW = boardPx.w + RIG_GAP + RIG_W;
  const totalH = Math.max(boardPx.h, RIG_H);
  const fit = Math.max(0.3, Math.min(MAX_SCALE, stageSize.width / totalW, stageSize.height / totalH));
  const scale = pedalDrag?.frozen?.scale ?? fit * zoom;
  const boardLeft = direction === 'ltr' ? 0 : RIG_W + RIG_GAP;
  const boardTop = (totalH - boardPx.h) / 2;
  const rigLeft = direction === 'ltr' ? boardPx.w + RIG_GAP : 0;
  const broken = patchBroken(state);

  useEffect(() => { pedalDragRef.current = pedalDrag; }, [pedalDrag]);
  useEffect(() => { cableDragRef.current = cableDrag; }, [cableDrag]);

  const nameOf = (id: string) => {
    const item = pedals.find((entry) => entry.instanceId === id);
    return item ? getEffectSpec(item.specId).name : id;
  };

  /** Signal-space rect of any node (pedals, boxes, plates). */
  function nodeRect(id: string, override?: Point): Rect | null {
    if (id === INPUT_NODE || id === OUTPUT_NODE) return plateRect(id, board);
    const point = override ?? positions[id];
    if (!point) return null;
    if (id === SPLITTER_NODE || id === MIXER_NODE) return { ...point, ...UTILITY_SIZE };
    const item = pedals.find((entry) => entry.instanceId === id);
    return item ? { ...point, ...footprintOf(item.specId) } : null;
  }

  /** Where a jack is drawn, in view millimetres. */
  function jackView(jack: JackRef, override?: { id: string; point: Point }): Point | null {
    const rect = nodeRect(jack.node, override?.id === jack.node ? override.point : undefined);
    if (!rect) return null;
    const point = jackPoint(rect, jack.node, jack.port);
    return { x: viewX(point.x, board, direction), y: point.y };
  }

  // The surface's frame border sits outside the board's coordinate box.
  const toBoardMm = (clientX: number, clientY: number): Point => {
    const element = surface.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    const border = element.clientLeft * (rect.width / element.offsetWidth);
    return {
      x: ((clientX - rect.left - border) / (rect.width - border * 2)) * board.w,
      y: ((clientY - rect.top - border) / (rect.height - border * 2)) * board.h,
    };
  };

  const allJacks = useMemo(() => {
    const nodes = [INPUT_NODE, OUTPUT_NODE, ...pedals.map((item) => item.instanceId), ...(parallel ? [SPLITTER_NODE, MIXER_NODE] : [])];
    return nodes.flatMap((node) => portsOf(node).map((port) => ({ node, port })));
  }, [pedals, parallel]);

  // ----- Pedal dragging ----------------------------------------------------

  function beginPedalPointer(id: string, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const rect = nodeRect(id);
    if (!rect) return;
    const view = viewRect(rect, board, direction);
    const pointer = toBoardMm(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    setPedalDrag({ id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offset: { x: pointer.x - view.x, y: pointer.y - view.y }, size: { w: rect.w, h: rect.h }, started: false, preview: null, guides: [], frozen: null });
  }

  function placeCandidate(drag: PedalDrag, clientX: number, clientY: number) {
    const pointer = toBoardMm(clientX, clientY);
    const viewTopLeft = { x: pointer.x - drag.offset.x, y: pointer.y - drag.offset.y };
    const wanted = signalPoint(viewTopLeft, drag.size, board, direction);
    const snapped = clampToBoard({ x: snap(wanted.x), y: snap(wanted.y) }, drag.size);
    const others = occupiedRects(positions, pedals, drag.id);
    const aligned = alignToGuides({ ...snapped, ...drag.size }, others);
    let point = clampToBoard({ x: aligned.x, y: aligned.y }, drag.size);
    let guides = aligned.guides;
    if (others.some((other) => rectsOverlap({ ...point, ...drag.size }, other))) {
      // Pedals cannot overlap: slide to the nearest free spot close by.
      const free = nearestFreeSpot(point, drag.size, others, 60);
      point = free ?? drag.preview ?? positions[drag.id];
      guides = [];
    }
    return { point, guides };
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pedal = pedalDragRef.current;
    if (pedal && pedal.pointerId === event.pointerId) {
      if (!pedal.started && Math.hypot(event.clientX - pedal.startX, event.clientY - pedal.startY) < DRAG_THRESHOLD_PX) return;
      const { point, guides } = placeCandidate(pedal, event.clientX, event.clientY);
      setPedalDrag({ ...pedal, started: true, preview: point, guides, frozen: pedal.frozen ?? { board, scale } });
      return;
    }
    const cable = cableDragRef.current;
    if (cable && cable.pointerId === event.pointerId) {
      if (!cable.started && Math.hypot(event.clientX - cable.startX, event.clientY - cable.startY) < DRAG_THRESHOLD_PX) return;
      const end = toBoardMm(event.clientX, event.clientY);
      let target: JackRef | null = null;
      let refused = '';
      let best = JACK_REACH_MM;
      for (const jack of allJacks) {
        if (jack.node === cable.anchor.node && jack.port === cable.anchor.port) continue;
        const at = jackView(jack);
        if (!at) continue;
        const distance = Math.hypot(at.x - end.x, at.y - end.y);
        if (distance >= best) continue;
        const result = connect(cable.base, cable.anchor, jack, { nodes: new Set(allJacks.map((entry) => entry.node)), mode: state.routing.mode });
        best = distance;
        target = result.ok ? jack : null;
        refused = result.ok ? '' : PATCH_FAILURE_TEXT[result.reason];
      }
      setCableDrag({ ...cable, started: true, end, target, refused });
    }
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const pedal = pedalDragRef.current;
    if (pedal && pedal.pointerId === event.pointerId) {
      setPedalDrag(null);
      if (!pedal.started) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      if (pedal.preview) props.onPlace(pedal.id, pedal.preview.x, pedal.preview.y);
      return;
    }
    const cable = cableDragRef.current;
    if (cable && cable.pointerId === event.pointerId) {
      setCableDrag(null);
      if (!cable.started) return;
      if (cable.target) {
        const result = connect(cable.base, cable.anchor, cable.target, { nodes: new Set(allJacks.map((entry) => entry.node)), mode: state.routing.mode });
        if (result.ok) props.onPatch(result.cables);
      } else if (cable.picked) {
        props.onPatch(cable.base);
      } else if (cable.refused) {
        props.onNotice(cable.refused);
      }
    }
  }

  function onStagePointerCancel() {
    setPedalDrag(null);
    setCableDrag(null);
  }

  // Escape cancels a drag.
  useEffect(() => {
    if (!pedalDrag && !cableDrag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onStagePointerCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pedalDrag, cableDrag]);

  // ----- Cables ------------------------------------------------------------

  function beginCable(jack: JackRef, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const existing = cableAt(state.patch.cables, jack);
    const anchor: JackRef = existing ? (existing.from.node === jack.node && existing.from.port === jack.port ? existing.to : existing.from) : jack;
    const base = existing ? disconnect(state.patch.cables, jack) : state.patch.cables;
    const start = jackView(jack) ?? { x: 0, y: 0 };
    setCableDrag({ pointerId: event.pointerId, anchor, base, picked: Boolean(existing), startX: event.clientX, startY: event.clientY, started: false, end: start, target: null, refused: '' });
  }

  // ----- Keyboard placement ----------------------------------------------

  function onPedalKeyDown(id: string, event: ReactKeyboardEvent<HTMLElement>) {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = nodeRect(id);
    if (!rect) return;
    const amount = event.shiftKey ? GRID_MM * 5 : GRID_MM;
    // Arrows move in view space; 'rtl' mirrors x back into signal space.
    const dx = step[0] * amount * (direction === 'ltr' ? 1 : -1);
    const point = clampToBoard({ x: rect.x + dx, y: rect.y + step[1] * amount }, rect);
    const others = occupiedRects(positions, pedals, id);
    if (others.some((other) => rectsOverlap({ ...point, w: rect.w, h: rect.h }, other))) {
      props.onNotice('那边已经有单块了。');
      return;
    }
    props.onPlace(id, point.x, point.y);
  }

  // ----- Rendering -------------------------------------------------------

  const px = (mm: number) => mm * PX_PER_MM;
  const draggingId = pedalDrag?.started ? pedalDrag.id : null;
  const override = draggingId && pedalDrag?.preview ? { id: draggingId, point: pedalDrag.preview } : undefined;

  const cableViews = state.patch.cables
    .filter((cable) => !(cableDrag?.started && cableDrag.picked && !cableDrag.base.includes(cable)))
    .map((cable) => {
      const a = jackView(cable.from, override);
      const b = jackView(cable.to, override);
      return a && b ? { cable, a, b, onChain: !parkedIds.has(cable.from.node) && !parkedIds.has(cable.to.node) } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const renderPedal = (item: ChainItem, index: number) => {
    const spec = getEffectSpec(item.specId);
    const rect = nodeRect(item.instanceId, override?.id === item.instanceId ? override.point : undefined);
    if (!rect) return null;
    const view = viewRect(rect, board, direction);
    const parked = parkedIds.has(item.instanceId);
    const bypassed = state.bypassed.has(item.instanceId);
    const selected = state.selected === item.instanceId;
    const chip = engineChip(spec, engineStatus(item.instanceId), namLoaded(spec));
    const skin = skins?.[spec.id];
    const style = { left: px(view.x), top: px(view.y), width: px(view.w), height: px(view.h), '--accent': spec.accent } as CSSProperties;
    return (
      <div
        key={item.instanceId}
        className={'pedal-node free' + (selected ? ' is-selected' : '') + (bypassed ? ' is-bypassed' : '') + (parked ? ' is-parked' : '') + (draggingId === item.instanceId ? ' is-dragging' : '') + (skin ? ' has-skin' : '')}
        style={style}
      >
        <button
          type="button"
          className="pedal-face"
          data-node-id={item.instanceId}
          aria-label={`${parked ? '未接入' : `${index + 1}.`} ${spec.name}${bypassed ? '，已旁通' : ''}。打开面板；方向键移动位置`}
          aria-current={selected ? 'true' : undefined}
          aria-expanded={deckOpen && selected}
          aria-controls="focus-deck"
          onClick={(event) => { if (!suppressClick.current) onOpenNode(item.instanceId, event.detail === 0); }}
          onPointerDown={(event) => beginPedalPointer(item.instanceId, event)}
          onKeyDown={(event) => onPedalKeyDown(item.instanceId, event)}
        >
          {/* Photo skins are small private WebPs drawn at the pedal's real size; next/image adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {skin ? <img className="pedal-skin" src={skin} alt="" draggable={false} /> : <PedalArt spec={spec} values={values[item.instanceId] ?? {}} />}
          {skin && <span className={'skin-led' + (bypassed ? '' : ' on')} aria-hidden="true" />}
          {chip && <span className={'engine-chip ' + chip.tone} title={chip.title}>{chip.text}</span>}
          {parked && <span className="parked-chip">未接入</span>}
        </button>
        {!parked && <span className="order-badge" aria-hidden="true">{index + 1}</span>}
        <button type="button" className="footswitch" aria-label={(bypassed ? '启用' : '旁通') + spec.name} aria-pressed={!bypassed} onClick={() => onBypass(item.instanceId)}>
          {!skin && <span className={'led' + (bypassed ? '' : ' on')} aria-hidden="true" />}
          {!skin && <span className="metal-switch" aria-hidden="true" />}
        </button>
      </div>
    );
  };

  function onBoxClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!suppressClick.current) onOpenNode(MIXER_NODE, event.detail === 0);
  }
  function onBoxPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    beginPedalPointer(event.currentTarget.dataset.boxId ?? MIXER_NODE, event);
  }
  function onBoxKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    onPedalKeyDown(event.currentTarget.dataset.boxId ?? MIXER_NODE, event);
  }

  const renderBox = (id: typeof SPLITTER_NODE | typeof MIXER_NODE) => {
    const rect = nodeRect(id, override?.id === id ? override.point : undefined);
    if (!rect) return null;
    const view = viewRect(rect, board, direction);
    const isMixer = id === MIXER_NODE;
    return (
      <button
        key={id}
        type="button"
        className={'utility-box' + (isMixer ? ' is-mixer' : ' is-splitter') + (state.selected === MIXER_NODE && isMixer ? ' is-selected' : '') + (draggingId === id ? ' is-dragging' : '')}
        data-node-id={isMixer ? MIXER_NODE : undefined}
        style={{ left: px(view.x), top: px(view.y), width: px(view.w), height: px(view.h) }}
        aria-label={isMixer ? `A/B 混合器，平衡 ${state.routing.blend}%。打开面板` : 'A/B 分流器。打开混合面板'}
        aria-controls="focus-deck"
        data-box-id={id}
        onClick={onBoxClick}
        onPointerDown={onBoxPointerDown}
        onKeyDown={onBoxKeyDown}
      >
        <strong>{isMixer ? 'Σ' : 'A/B'}</strong>
        <small>{isMixer ? '混合' : '分流'}</small>
      </button>
    );
  };

  const plate = (id: typeof INPUT_NODE | typeof OUTPUT_NODE) => {
    const view = viewRect(plateRect(id, board), board, direction);
    const style = { left: px(view.x), top: px(view.y), width: px(view.w), height: px(view.h) };
    return id === INPUT_NODE ? (
      <button key={id} type="button" className="board-plate is-input" data-node-id="input" style={style} aria-label={`吉他输入：${sourceLabel}。更换输入`} onClick={onOpenInput}>
        <small>IN</small>
      </button>
    ) : (
      <span key={id} className="board-plate is-output" style={style} aria-hidden="true"><small>OUT</small></span>
    );
  };

  const jackDot = (jack: JackRef) => {
    const at = jackView(jack, override);
    if (!at) return null;
    const plugged = Boolean(cableAt(state.patch.cables, jack));
    const isTarget = cableDrag?.target && cableDrag.target.node === jack.node && cableDrag.target.port === jack.port;
    return (
      <span
        key={`${jack.node}:${jack.port}`}
        className={'jack-dot' + (isSourcePort(jack.port) ? ' is-out' : ' is-in') + (plugged ? ' is-plugged' : '') + (isTarget ? ' is-target' : '')}
        style={{ left: px(at.x), top: px(at.y) }}
        role="presentation"
        title={`${jackLabel(jack.node, jack.port, nameOf)}：拖动接线${plugged ? '，拖开拔线' : ''}`}
        onPointerDown={(event) => beginCable(jack, event)}
      />
    );
  };

  const guideLines = pedalDrag?.started ? pedalDrag.guides.map((guide, index) => {
    if (guide.axis === 'x') {
      const x = viewX(guide.at, board, direction);
      return <span key={index} className="align-guide is-vertical" style={{ left: px(x), top: px(guide.from) - 12, height: px(guide.to - guide.from) + 24 }} />;
    }
    const a = viewX(guide.from, board, direction);
    const b = viewX(guide.to, board, direction);
    return <span key={index} className="align-guide is-horizontal" style={{ top: px(guide.at), left: px(Math.min(a, b)) - 12, width: px(Math.abs(b - a)) + 24 }} />;
  }) : null;

  const outputJack = jackView({ node: OUTPUT_NODE, port: 'in' });
  const rigAnchorY = boardTop + (outputJack ? px(outputJack.y) : boardPx.h / 2);
  const rigTop = Math.max(0, Math.min(totalH - RIG_H, rigAnchorY - RIG_H / 2));
  const ampSpec = getAmpSpec(state.amp.ampId);
  const cabSpec = getCabSpec(state.amp.cabId);
  const chainIndex = new Map([...state.chain].map((item, index) => [item.instanceId, index]));

  const zoomTo = (next: number) => setZoom(Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], next)));
  const zoomStep = (delta: 1 | -1) => {
    const at = ZOOM_STEPS.findIndex((step) => step >= zoom - 1e-6);
    zoomTo(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? 3 : at) + delta))]);
  };

  return (
    <div
      ref={stage}
      className={'board-stage free-board' + (pedalDrag?.started || cableDrag?.started ? ' is-dragging' : '') + (zoom > 1 ? ' is-zoomed' : '') + (direction === 'rtl' ? ' is-rtl' : '')}
      onPointerMove={onStagePointerMove}
      onPointerUp={onStagePointerUp}
      onPointerCancel={onStagePointerCancel}
    >
      <div className="board-tools" role="toolbar" aria-label="效果器板">
        <button type="button" onClick={props.onTidy} title="按信号顺序重新摆放并整理线缆">整理</button>
        <button type="button" onClick={() => onOpenNode(MIXER_NODE)} title="串联或双路并联">{parallel ? '并联' : '串联'}</button>
        <button type="button" onClick={() => props.onDirectionChange(direction === 'ltr' ? 'rtl' : 'ltr')} title="信号方向：真实效果器板通常从右往左走">{direction === 'rtl' ? '← 右进' : '左进 →'}</button>
        <span className="board-zoom-controls" role="group" aria-label="缩放">
          <button type="button" aria-label="缩小" onClick={() => zoomStep(-1)}>−</button>
          <button type="button" aria-label="适应窗口" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="放大" onClick={() => zoomStep(1)}>+</button>
        </span>
      </div>
      {broken && (state.chain.length > 0 || state.parked.length > 0) && (
        <p className="patch-warning" role="status">信号没有一路接到输出。现在按已接好的顺序送到音箱；把最后一块的输出接到 OUT 就完整了。</p>
      )}
      <div className="board-frame" style={{ width: totalW * scale, height: totalH * scale }}>
        <div className="board-canvas" style={{ width: totalW, height: totalH, transform: `scale(${scale})` }}>
          <div ref={surface} className="board-surface free" style={{ left: boardLeft, top: boardTop, width: boardPx.w, height: boardPx.h }}>
            <svg className="cable-layer" width={boardPx.w} height={boardPx.h} viewBox={`0 0 ${board.w} ${board.h}`} aria-hidden="true">
              {cableViews.map(({ cable, a, b, onChain }) => (
                <g key={`${cable.from.node}:${cable.from.port}-${cable.to.node}:${cable.to.port}`} className={'cable' + (onChain ? ' on-chain' : ' is-side')}>
                  <path className="cable-shadow" d={cablePath(a, b, direction)} />
                  <path className="cable-body" d={cablePath(a, b, direction)} />
                  <circle className="cable-plug" cx={a.x} cy={a.y} r={3.2} />
                  <circle className="cable-plug" cx={b.x} cy={b.y} r={3.2} />
                </g>
              ))}
              {cableDrag?.started && (() => {
                const anchorAt = jackView(cableDrag.anchor);
                if (!anchorAt) return null;
                const sourceIsAnchor = isSourcePort(cableDrag.anchor.port);
                const end = cableDrag.target ? jackView(cableDrag.target) ?? cableDrag.end : cableDrag.end;
                const [a, b] = sourceIsAnchor ? [anchorAt, end] : [end, anchorAt];
                return (
                  <g className={'cable is-live' + (cableDrag.target ? ' is-valid' : cableDrag.refused ? ' is-refused' : '')}>
                    <path className="cable-body" d={cablePath(a, b, direction)} />
                    <circle className="cable-plug" cx={end.x} cy={end.y} r={3.6} />
                  </g>
                );
              })()}
            </svg>
            {plate(INPUT_NODE)}
            {plate(OUTPUT_NODE)}
            {parallel && renderBox(SPLITTER_NODE)}
            {parallel && renderBox(MIXER_NODE)}
            {pedals.map((item) => renderPedal(item, chainIndex.get(item.instanceId) ?? -1))}
            {cableViews.filter((entry) => entry.onChain).map(({ cable, a, b }) => {
              const mid = cableMidpoint(a, b);
              return (
                <button
                  key={`add-${cable.from.node}:${cable.from.port}-${cable.to.node}:${cable.to.port}`}
                  type="button"
                  className="cable-add"
                  style={{ left: px(mid.x), top: px(mid.y) }}
                  aria-label={`在 ${jackLabel(cable.from.node, cable.from.port, nameOf)} 和 ${jackLabel(cable.to.node, cable.to.port, nameOf)} 之间插入效果器`}
                  onClick={() => props.onInsertOnCable(cable)}
                >+</button>
              );
            })}
            {allJacks.map(jackDot)}
            {guideLines}
            {pedals.length === 0 && <p className="board-empty">点线上的 <b>+</b> 或按 ⌘/Ctrl + K 添加第一块效果器。</p>}
          </div>
          <div className="rig-dock" style={{ left: rigLeft, top: rigTop, width: RIG_W, height: RIG_H }}>
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
          </div>
          {outputJack && (
            <svg className="rig-cable" width={totalW} height={totalH} aria-hidden="true">
              <path d={(() => {
                const x = boardLeft + px(outputJack.x);
                const y = boardTop + px(outputJack.y);
                const rigX = direction === 'ltr' ? rigLeft + 8 : rigLeft + RIG_W - 8;
                const rigY = rigTop + RIG_H * 0.55;
                const sign = direction === 'ltr' ? 1 : -1;
                return `M ${x} ${y} C ${x + sign * 40} ${y + 30}, ${rigX - sign * 40} ${rigY + 30}, ${rigX} ${rigY}`;
              })()} />
            </svg>
          )}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {cableDrag?.started ? (cableDrag.target ? `松开接到${jackLabel(cableDrag.target.node, cableDrag.target.port, nameOf)}` : cableDrag.refused || (cableDrag.picked ? '松开会拔掉这根线' : '拖到另一个插孔')) : ''}
      </p>
    </div>
  );
}
