'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CIRCUIT_EFFECT_IDS,
  createLiveSession,
  disposeLiveSession,
  refreshLiveSession,
  renderBoardToWav,
  requestInstrumentStream,
  setLiveInput,
  type BoardAudioConfig,
  type EffectStatus,
  type LiveAudioSession,
} from './audio/audio-engine';
import { LiveSessionController } from './audio/live-session-controller';
import { BoardHistory } from './board-history';
import type { AudioChainItem, RoutingConfig, SignalLane } from './audio/audio-core';
import {
  createBrowserNamModelRepository,
  createNamModelRecord,
  parseNamModel,
  type NamModelRecord,
  type NamModelRepository,
} from './audio/nam-model';
import {
  CHORD_PROGRESSIONS,
  GUITAR_VOICES,
  PERFORMANCE_SPECS,
  formatSourceConfig,
  getChordProgression,
  type SourceConfig,
} from './audio/source-catalog';
import { ToneAgentDock, type ToneAgentTurn } from './agent/ToneAgentDock';
import {
  applyToneAgentActions,
  captureToneAgentBoard,
  type ToneAgentBoardState,
  type ToneAgentMessage,
} from './agent/tone-agent-runtime';
import { isToneAgentAbort, requestToneAgentStream, ToneAgentHttpError } from './agent/tone-agent-stream';
import {
  AMP_SPECS,
  CAB_SPECS,
  getAmpSpec,
  getCabSpec,
  makeDefaultAmpValues,
  makeDefaultCabValues,
  type AmpCabConfig,
} from './amps/catalog';
import {
  EFFECT_SPECS,
  FACTORY_PRESETS,
  STYLE_TAGS,
  STYLE_TAG_LABELS,
  formatControlValue,
  getEffectSearchText,
  getEffectSpec,
  getPresetSearchText,
  instantiatePreset,
  makeDefaultValues,
  type ControlSpec,
  type EffectCategory,
  type EffectSpec,
  type InstantiatedPreset,
  type StyleTag,
} from './effects/catalog';
import { getControlHelp, type ControlOwnerKind } from './effects/control-help';
import { getPedalControlLabel } from './effects/control-labels';
import { getEffectFidelity } from './effects/fidelity';
import {
  captureUserPreset,
  instantiateUserPreset,
  parseUserPresets,
  type UserPreset,
} from './effects/user-presets';

type ChainItem = AudioChainItem;
type Values = Record<string, Record<string, number>>;
type BoardUiState = {
  chain: ChainItem[];
  snapshots: Record<'A' | 'B', Values>;
  snapshot: 'A' | 'B';
  selected: string;
  bypassed: Set<string>;
  source: SourceConfig;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  output: number;
  mode: 'dry' | 'wet';
  activePresetName: string;
};
type AgentUndoEntry = {
  baseline: BoardUiState;
  appliedRevision: number;
};
type LibraryMode = 'effects' | 'presets' | 'output';
type StyleFilter = 'All' | StyleTag;
type HelpTarget = {
  kind: ControlOwnerKind;
  modelId: string;
  ownerName: string;
  control: ControlSpec;
};

const categoryNames: Record<'All' | EffectCategory, string> = {
  All: '全部',
  Dynamics: '动态',
  Tone: '音色',
  Drive: '增益',
  Mod: '调制',
  Delay: '延迟',
  Space: '空间',
};
const wave = [18, 42, 72, 34, 85, 52, 66, 28, 90, 46, 74, 38, 82, 56, 26, 68, 88, 44, 72, 32, 62, 94, 48, 76, 36, 84, 54, 24, 70, 91, 42, 68, 34, 80, 52, 74, 30, 63, 87, 46];
const initialFactoryPreset = FACTORY_PRESETS.find((preset) => preset.id === 'reverse-wall') ?? FACTORY_PRESETS[0];
const initialBoard = instantiatePreset(initialFactoryPreset);

/** Minimum spacing between live audio updates while a knob is dragged. */
const PLAYBACK_REFRESH_INTERVAL_MS = 30;

function cloneValues(values: Values) {
  return Object.fromEntries(Object.entries(values).map(([id, controls]) => [id, { ...controls }]));
}

function cloneBoardUiState(state: BoardUiState): BoardUiState {
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

function removeInstanceValues(values: Values, instanceId: string) {
  const next = cloneValues(values);
  delete next[instanceId];
  return next;
}

function isCircuitModelled(effectId: string) {
  return getEffectFidelity(effectId)?.runtime === 'circuit';
}

function getPlaybackProgress(session: LiveAudioSession | null) {
  if (!session || session.context.state === 'closed' || !Number.isFinite(session.duration) || session.duration <= 0 || !Number.isFinite(session.startedAt)) return null;
  const currentTime = session.context.currentTime;
  if (!Number.isFinite(currentTime)) return null;
  const elapsed = currentTime - session.startedAt;
  if (!Number.isFinite(elapsed)) return null;
  const offset = ((elapsed % session.duration) + session.duration) % session.duration;
  return (offset / session.duration) * 100;
}

/** Both snapshots start as the preset; B diverges only when the player edits it. */
function makeSnapshots(board: InstantiatedPreset) {
  return { A: cloneValues(board.values), B: cloneValues(board.values) };
}

/**
 * Transport progress, animated from the audio clock with requestAnimationFrame
 * and written straight to the DOM so playback does not re-render the page.
 */
function PlaybackWaveform({ playback, playing, loading }: { playback: LiveSessionController<BoardAudioConfig, LiveAudioSession>; playing: boolean; loading: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let shown = -1;
    const write = (progress: number) => {
      if (bar.current) bar.current.style.width = String(progress) + '%';
      const rounded = Math.round(progress);
      if (rounded === shown || !host.current) return;
      shown = rounded;
      host.current.setAttribute('aria-valuenow', String(rounded));
      host.current.setAttribute('aria-valuetext', '试听进度 ' + String(rounded) + '%');
    };
    write(0);
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const progress = getPlaybackProgress(playback.current);
      if (progress !== null) write(progress);
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [playback, playing]);

  return (
    <div ref={host} className={'waveform' + (loading ? ' is-loading' : '')} role="progressbar" aria-label="试听进度" aria-valuemin={0} aria-valuemax={100} aria-busy={loading}>
      <i ref={bar} />{wave.map((height, index) => <b key={String(height) + '-' + String(index)} style={{ height: String(height) + '%' }} />)}
      {loading && <span className="waveform-status">正在加载试听…</span>}
    </div>
  );
}

/** Drag distance (px) for the full knob sweep; Shift or a second finger drags 5x finer. */
const KNOB_DRAG_RANGE_PX = 180;
const KNOB_FINE_FACTOR = 5;

function clampKnob(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function KnobControl({ control, displayLabel, value, disabled, tutorialEnabled, ownerKind, modelId, ownerName, onChange, onHelp }: {
  control: ControlSpec;
  displayLabel?: string;
  value: number;
  disabled: boolean;
  tutorialEnabled: boolean;
  ownerKind: ControlOwnerKind;
  modelId: string;
  ownerName: string;
  onChange: (value: number) => void;
  onHelp: (target: HelpTarget) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const hit = useRef<HTMLSpanElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; start: number; fine: boolean } | null>(null);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  const readout = formatControlValue(control, value);
  const label = displayLabel ?? control.label;
  const help = tutorialEnabled && (
    <button
      className="help-trigger"
      type="button"
      aria-label={`查看${ownerName}的${control.label}旋钮说明`}
      onClick={(event) => { event.stopPropagation(); onHelp({ kind: ownerKind, modelId, ownerName, control }); }}
    >?</button>
  );

  // Wheel needs a non-passive listener to stop the page from scrolling, and
  // only acts while the knob has focus so scrolling past a pedal is safe.
  useEffect(() => {
    const element = input.current;
    const target = hit.current;
    if (!element || !target || control.options) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== element || element.disabled) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.2 : 1;
      const { value: current, onChange: change } = latest.current;
      const next = clampKnob(current + (event.deltaY < 0 ? step : -step) * Math.max(1, Math.min(5, Math.abs(event.deltaY) / 40)));
      if (next !== current) change(next);
    };
    // The input ignores pointer events, so wheel events land on the wrapper.
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, [control.options]);

  if (control.options) {
    const on = value >= 50;
    return (
      <div className={'knob-control is-switch' + (tutorialEnabled ? ' is-tutorial' : '')}>
        <span className="knob-label-row"><span className="knob-label">{label}</span>{help}</span>
        <button
          type="button"
          role="switch"
          className="pedal-switch"
          aria-checked={on}
          aria-label={control.label}
          disabled={disabled}
          onClick={() => onChange(on ? 0 : 100)}
        >
          <span className="pedal-switch-lever" aria-hidden="true" />
        </button>
        <span className="knob-readout">{readout}</span>
      </div>
    );
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    input.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: value, fine: event.shiftKey };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // Switching fine mode mid-drag re-anchors so the knob does not jump.
    if (event.shiftKey !== state.fine) {
      Object.assign(state, { x: event.clientX, y: event.clientY, start: value, fine: event.shiftKey });
      return;
    }
    const travel = (state.y - event.clientY) + (event.clientX - state.x);
    const scale = 100 / KNOB_DRAG_RANGE_PX / (state.fine ? KNOB_FINE_FACTOR : 1);
    const next = clampKnob(state.start + travel * scale);
    if (next !== value) onChange(next);
  };
  const endDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <div className={'knob-control' + (tutorialEnabled ? ' is-tutorial' : '')}>
      <span className="knob-label-row"><span className="knob-label">{label}</span>{help}</span>
      <span
        ref={hit}
        className={'knob-hit' + (disabled ? ' is-disabled' : '')}
        title="上下或左右拖动调节，Shift 微调，双击复位"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { if (!disabled) onChange(control.defaultValue); }}
      >
        <span className="knob" style={{ '--angle': String(-138 + value * 2.76) + 'deg' } as CSSProperties} aria-hidden="true"><span /></span>
        <input
          ref={input}
          type="range"
          min="0"
          max="100"
          step="1"
          value={value}
          disabled={disabled}
          aria-label={control.label}
          aria-valuetext={readout}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="knob-readout">{readout}</span>
    </div>
  );
}

function ControlHelpDialog({ target, onClose }: { target: HelpTarget | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const lesson = target ? getControlHelp(target.kind, target.modelId, target.control) : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (target && !element.open) element.showModal();
    if (!target && element.open) element.close();
  }, [target]);

  return (
    <dialog
      ref={dialog}
      className="control-help-dialog"
      aria-labelledby="control-help-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {target && lesson && <div className="help-sheet">
        <header><div><span>{target.ownerName}</span><h2 id="control-help-title">{target.control.label}</h2></div><button type="button" onClick={onClose}>关闭</button></header>
        <div className="help-range"><span>实际范围</span><strong>{lesson.range}</strong></div>
        <p className="help-summary">{lesson.summary}</p>
        <div className="help-directions"><section><span>向左调</span><p>{lesson.low}</p></section><section><span>向右调</span><p>{lesson.high}</p></section></div>
        <div className="help-tip"><span>调音建议</span><p>{lesson.tip}</p></div>
      </div>}
    </dialog>
  );
}

function SourcePickerDialog({ open, source, onChange, onClose }: {
  open: boolean;
  source: SourceConfig;
  onChange: (source: SourceConfig) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="source-picker-dialog"
      aria-labelledby="source-picker-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="source-picker-sheet">
        <header><div><span>固定清音输入</span><h2 id="source-picker-title">选择电吉他与演奏</h2></div><button type="button" onClick={onClose}>完成</button></header>
        <section>
          <h3>电吉他音色</h3>
          <div className="source-choice-grid guitars" role="radiogroup" aria-label="电吉他音色">
            {GUITAR_VOICES.map((voice) => (
              <button key={voice.id} type="button" role="radio" aria-checked={source.guitar === voice.id} className={source.guitar === voice.id ? 'active' : ''} onClick={() => onChange({ ...source, guitar: voice.id })}>
                <strong>{voice.name}</strong><small>{voice.description}</small>
              </button>
            ))}
          </div>
          <p className="sample-license-note">
            真实采样 · 未处理 DI · CC0 · <a href="https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html" target="_blank" rel="noreferrer">FreePats Direct DI</a>
          </p>
        </section>
        <section>
          <h3>演奏方式</h3>
          <div className="source-choice-grid performance" role="radiogroup" aria-label="演奏方式">
            {PERFORMANCE_SPECS.map((performance) => <button key={performance.id} type="button" role="radio" aria-checked={source.performance === performance.id} className={source.performance === performance.id ? 'active' : ''} onClick={() => onChange({ ...source, performance: performance.id })}><strong>{performance.name}</strong><small>{performance.description}</small></button>)}
          </div>
        </section>
        <section>
          <h3>和弦进行</h3>
          <div className="source-choice-grid progressions" role="radiogroup" aria-label="和弦进行">
            {CHORD_PROGRESSIONS.map((progression) => (
              <button key={progression.id} type="button" role="radio" aria-checked={source.progression === progression.id} className={source.progression === progression.id ? 'active' : ''} onClick={() => onChange({ ...source, progression: progression.id })}>
                <strong>{progression.name}</strong><small>{progression.chords}</small>
              </button>
            ))}
          </div>
        </section>
      </div>
    </dialog>
  );
}

function Cable() {
  return <span className="cable" aria-hidden="true"><i /><b /><i /></span>;
}

function MiniPedal({ spec }: { spec: EffectSpec }) {
  const style = { '--finish': spec.finish, '--ink': spec.ink } as CSSProperties;
  const isWide = spec.wide || spec.controls.length > 4;
  return <span className={'mini-pedal' + (isWide ? ' is-wide' : '')} style={style} aria-hidden="true"><i /><i /><i /><b /></span>;
}

function StyleFilters({ value, onChange }: { value: StyleFilter; onChange: (value: StyleFilter) => void }) {
  return (
    <div className="style-filters" role="group" aria-label="按风格筛选">
      <button type="button" className={value === 'All' ? 'active' : ''} aria-pressed={value === 'All'} onClick={() => onChange('All')}><span>全部</span><small>All</small></button>
      {STYLE_TAGS.map((tag) => (
        <button key={tag} type="button" className={value === tag ? 'active' : ''} aria-pressed={value === tag} onClick={() => onChange(tag)}>
          <span>{STYLE_TAG_LABELS[tag]}</span><small>{tag}</small>
        </button>
      ))}
    </div>
  );
}

function DemoPedal({ item, index, values, selected, bypassed, namLoaded, engineStatus, tutorialEnabled, onSelect, onValue, onBypass, onDrop, onHelp }: {
  item: ChainItem;
  index: number;
  values: Record<string, number>;
  selected: boolean;
  bypassed: boolean;
  namLoaded: boolean;
  /** Live engine state while playing; undefined when stopped. */
  engineStatus?: EffectStatus;
  onSelect: () => void;
  onValue: (id: string, value: number) => void;
  onBypass: () => void;
  onDrop: (payload: string) => void;
  tutorialEnabled: boolean;
  onHelp: (target: HelpTarget) => void;
}) {
  const spec = getEffectSpec(item.specId);
  const manyControls = spec.controls.length > 4;
  const isWide = spec.wide || manyControls;
  const columns = spec.controls.length >= 7 ? 4 : spec.controls.length === 4 ? 2 : 3;
  // Two knob rows push the name plate down (a 2x2 layout included).
  const twoRows = Math.ceil(spec.controls.length / columns) > 1;
  const style = {
    '--finish': spec.finish,
    '--ink': spec.ink,
    '--accent': spec.accent,
    '--knob-columns': columns,
  } as CSSProperties;

  return (
    <article
      className={'pedal-unit' + (isWide ? ' is-wide' : '') + (selected ? ' is-selected' : '') + (bypassed ? ' is-bypassed' : '')}
      draggable
      tabIndex={0}
      aria-label={String(index + 1) + '. ' + spec.name + (bypassed ? '，已旁通' : '')}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect();
      }}
      onDragStart={(event) => event.dataTransfer.setData('text/plain', 'move:' + item.instanceId)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/plain')); }}
    >
      <span className="order-badge">{index + 1}</span>
      <div className={'pedal-body' + (twoRows ? ' has-many' : '')} style={style}>
        <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
        <span className="jack jack-left" /><span className="jack jack-right" />
        <div className="pedal-maker">{spec.maker}</div>
        {spec.nam && <span className={'nam-status ' + (namLoaded ? 'loaded' : 'missing')}>{namLoaded ? 'LOCAL NAM' : 'NAM MISSING'}</span>}
        {!spec.nam && engineStatus === 'passthrough' && <span className="nam-status missing" title="该效果的音频引擎没有加载，当前为直通">直通 · 引擎未加载</span>}
        {!spec.nam && engineStatus === 'fallback' && <span className="nam-status missing" title="电路求解出错，已自动切回干声">FALLBACK</span>}
        {!spec.nam && engineStatus !== 'passthrough' && engineStatus !== 'fallback' && CIRCUIT_EFFECT_IDS.has(spec.id) && <span className="nam-status loaded" title="按原理图逐元件实时求解">CIRCUIT</span>}
        <div className="knob-row">
          {spec.controls.map((control) => (
            <KnobControl
              key={control.id}
              control={control}
              displayLabel={getPedalControlLabel(spec.id, control.id)}
              value={values[control.id] ?? control.defaultValue}
              disabled={bypassed}
              tutorialEnabled={tutorialEnabled}
              ownerKind="effect"
              modelId={spec.id}
              ownerName={spec.name}
              onChange={(value) => onValue(control.id, value)}
              onHelp={onHelp}
            />
          ))}
        </div>
        <div className="pedal-lines" aria-hidden="true"><i /><i /><i /></div>
        <h2>{spec.name}</h2>
        <button
          className="footswitch"
          type="button"
          aria-label={(bypassed ? '启用' : '旁通') + spec.name}
          aria-pressed={!bypassed}
          onClick={(event) => { event.stopPropagation(); onBypass(); }}
        >
          <span className={'led' + (bypassed ? '' : ' on')} aria-hidden="true" />
          <span className="metal-switch" aria-hidden="true" />
          <small>{bypassed ? '已旁通' : '已启用'}</small>
        </button>
      </div>
    </article>
  );
}

export default function Home() {
  const [chain, setChain] = useState<ChainItem[]>(initialBoard.chain);
  const [snapshots, setSnapshots] = useState<Record<'A' | 'B', Values>>(() => makeSnapshots(initialBoard));
  const [snapshot, setSnapshot] = useState<'A' | 'B'>('A');
  const [selected, setSelected] = useState(initialBoard.chain[0]?.instanceId ?? '');
  const [bypassed, setBypassed] = useState<Set<string>>(new Set(initialBoard.bypassed));
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('effects');
  const [category, setCategory] = useState<'All' | EffectCategory>('All');
  const [circuitOnly, setCircuitOnly] = useState(false);
  const [liveInputOn, setLiveInputOn] = useState(false);
  const [liveInputBusy, setLiveInputBusy] = useState(false);
  const [styleFilter, setStyleFilter] = useState<StyleFilter>('All');
  const [search, setSearch] = useState('');
  const [presetSearch, setPresetSearch] = useState('');
  const [zoom, setZoom] = useState(0.94);
  const [mode, setMode] = useState<'dry' | 'wet'>('wet');
  const [routing, setRouting] = useState<RoutingConfig>(initialBoard.routing);
  const [amp, setAmp] = useState<AmpCabConfig>(initialBoard.amp);
  const [source, setSource] = useState<SourceConfig>(initialBoard.source);
  const [output, setOutput] = useState(initialBoard.output);
  const [activePresetName, setActivePresetName] = useState(initialFactoryPreset.name);
  const [presetName, setPresetName] = useState('我的音色');
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [playing, setPlaying] = useState(false);
  // Stopping playback closes the session, and with it the instrument stream.
  const liveInputActive = liveInputOn && playing;
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [render, setRender] = useState<'idle' | 'busy' | 'ready'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [tutorialEnabled, setTutorialEnabled] = useState(false);
  const [helpTarget, setHelpTarget] = useState<HelpTarget | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const [agentTurns, setAgentTurns] = useState<ToneAgentTurn[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [audioError, setAudioError] = useState('');
  const [namModels, setNamModels] = useState<Record<string, NamModelRecord>>({});
  const [namImporting, setNamImporting] = useState('');
  const [playback] = useState(() => new LiveSessionController<BoardAudioConfig, LiveAudioSession>(createLiveSession, disposeLiveSession));
  const previousMonitorMode = useRef(mode);
  const helpInvoker = useRef<HTMLElement | null>(null);
  const agentAbort = useRef<AbortController | null>(null);
  const playbackLoadingRef = useRef(false);
  const boardRevision = useRef(0);
  const history = useRef(new BoardHistory<BoardUiState>());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const playbackRefreshSerial = useRef(0);
  const lastPlaybackRefreshAt = useRef(0);
  const [effectStatus, setEffectStatus] = useState<ReadonlyMap<string, EffectStatus>>(() => new Map());
  const agentTurnSerial = useRef(0);
  const agentUndo = useRef(new Map<string, AgentUndoEntry>());
  const manualPedalSerial = useRef(0);
  const namRepository = useRef<NamModelRepository | null>(null);
  const values = snapshots[snapshot];
  const selectedIndex = chain.findIndex((item) => item.instanceId === selected);
  const selectedSpec = selectedIndex >= 0 ? getEffectSpec(chain[selectedIndex].specId) : null;
  const selectedLane = chain[selectedIndex]?.lane ?? 'A';
  const selectedLaneItems = routing.mode === 'parallel' ? chain.filter((item) => (item.lane ?? 'A') === selectedLane) : chain;
  const selectedLaneIndex = selectedLaneItems.findIndex((item) => item.instanceId === selected);
  const ampSpec = getAmpSpec(amp.ampId);
  const cabSpec = getCabSpec(amp.cabId);

  const library = useMemo(() => {
    const query = search.trim().toLowerCase();
    return EFFECT_SPECS.filter((spec) => {
      const categoryMatches = category === 'All' || spec.category === category;
      const styleMatches = styleFilter === 'All' || spec.styleTags?.includes(styleFilter);
      const queryMatches = !query || getEffectSearchText(spec).toLowerCase().includes(query);
      const engineMatches = !circuitOnly || isCircuitModelled(spec.id);
      return categoryMatches && styleMatches && queryMatches && engineMatches;
    });
  }, [category, circuitOnly, search, styleFilter]);

  const factoryPresetLibrary = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    return FACTORY_PRESETS.filter((preset) => {
      const styleMatches = styleFilter === 'All' || preset.styleTags?.includes(styleFilter);
      const queryMatches = !query || getPresetSearchText(preset).toLowerCase().includes(query);
      return styleMatches && queryMatches;
    });
  }, [presetSearch, styleFilter]);

  const userPresetLibrary = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    return userPresets.filter((preset) => {
      const effects = preset.chain.map((item) => getEffectSpec(item.specId));
      const styleMatches = styleFilter === 'All' || effects.some((effect) => effect.styleTags?.includes(styleFilter));
      const queryMatches = !query || [preset.name, ...effects.map(getEffectSearchText)].join(' ').toLowerCase().includes(query);
      return styleMatches && queryMatches;
    });
  }, [presetSearch, styleFilter, userPresets]);

  const audioConfig = useMemo<BoardAudioConfig>(() => ({
    chain,
    values,
    bypassed: [...bypassed],
    source,
    mode,
    output,
    routing,
    amp,
    namModels,
  }), [chain, values, bypassed, source, mode, output, routing, amp, namModels]);
  const toneAgentBoard = useMemo<ToneAgentBoardState>(() => captureToneAgentBoard({
    name: activePresetName,
    selectedInstanceId: selected,
    chain: chain.map((item) => ({ ...item, lane: item.lane ?? 'A' })),
    values,
    bypassed: [...bypassed],
    source,
    routing,
    amp,
    output,
    monitorMode: mode,
  }), [activePresetName, selected, chain, values, bypassed, source, routing, amp, output, mode]);
  const latestAudioConfig = useRef(audioConfig);

  useEffect(() => {
    latestAudioConfig.current = audioConfig;
  }, [audioConfig]);

  useEffect(() => {
    const timer = window.setTimeout(() => setUserPresets(parseUserPresets(window.localStorage.getItem('sonic-board-user-presets'))), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    try {
      const repository = namRepository.current ?? createBrowserNamModelRepository();
      namRepository.current = repository;
      void repository.list().then((records) => {
        if (active) setNamModels(Object.fromEntries(records.map((record) => [record.slotId, record])));
      }).catch(() => {
        // Private models are optional; unsupported storage keeps NAM pedals in passthrough.
      });
    } catch {
      // Server rendering and private-mode browsers may not expose IndexedDB.
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const watchSession = () => {
      const session = playback.current;
      if (session?.context.state === 'closed') {
        setPlaying(false);
        setAudioError('试听已停止，请重试。');
        void playback.stop().catch(() => {
          // The controller invalidates the session before disposal begins.
        });
        return;
      }
    };
    watchSession();
    const timer = window.setInterval(watchSession, 500);
    return () => window.clearInterval(timer);
  }, [playback, playing]);

  useEffect(() => {
    const refreshSerial = ++playbackRefreshSerial.current;
    const session = playback.current;
    if (!playing || !session) {
      previousMonitorMode.current = mode;
      return;
    }
    // Knob moves are applied in place by the engine, so they are throttled
    // (heard while dragging) rather than debounced until the drag stops.
    const sinceLast = performance.now() - lastPlaybackRefreshAt.current;
    const delay = previousMonitorMode.current === mode ? Math.max(0, PLAYBACK_REFRESH_INTERVAL_MS - sinceLast) : 0;
    previousMonitorMode.current = mode;
    const timer = window.setTimeout(() => {
      if (playback.current !== session || !playback.requested) return;
      lastPlaybackRefreshAt.current = performance.now();
      void refreshLiveSession(session, audioConfig).catch(async () => {
        if (refreshSerial !== playbackRefreshSerial.current || playback.current !== session || !playback.requested) return;
        try {
          await playback.stop();
        } catch {
          // The controller has already invalidated the failed session.
        }
        if (refreshSerial !== playbackRefreshSerial.current || playback.current !== null || playback.requested) return;
        setPlaying(false);
        setAudioError('试听更新失败，请重试。');
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [audioConfig, mode, playback, playing]);

  useEffect(() => () => {
    agentAbort.current?.abort();
    void playback.dispose();
  }, [playback]);

  /** Call before every board edit; `record` adds an undo step (not for selection or monitoring). */
  function markBoardChanged(record = true) {
    boardRevision.current += 1;
    if (!record) return;
    history.current.record(captureCurrentBoardUiState());
    syncHistoryState();
  }

  function syncHistoryState() {
    setHistoryState({ canUndo: history.current.canUndo, canRedo: history.current.canRedo });
  }

  function undoBoard() {
    const previous = history.current.undo(captureCurrentBoardUiState());
    if (!previous) return;
    restoreBoardUiState(previous);
    syncHistoryState();
  }

  function redoBoard() {
    const next = history.current.redo(captureCurrentBoardUiState());
    if (!next) return;
    restoreBoardUiState(next);
    syncHistoryState();
  }

  function captureCurrentBoardUiState(): BoardUiState {
    return cloneBoardUiState({
      chain,
      snapshots,
      snapshot,
      selected,
      bypassed,
      source,
      routing,
      amp,
      output,
      mode,
      activePresetName,
    });
  }

  function selectPedal(instanceId: string) {
    if (selected === instanceId) return;
    markBoardChanged(false);
    setSelected(instanceId);
  }

  function applyBoard(board: InstantiatedPreset, name: string) {
    markBoardChanged();
    setChain(board.chain);
    setSnapshots(makeSnapshots(board));
    setSnapshot('A');
    setSelected(board.selectedInstanceId && board.chain.some((item) => item.instanceId === board.selectedInstanceId) ? board.selectedInstanceId : board.chain[0]?.instanceId ?? '');
    setBypassed(new Set(board.bypassed));
    setSource(board.source);
    setOutput(board.output);
    setRouting({ ...board.routing });
    setAmp({ ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } });
    setActivePresetName(name);
    setRender('idle');
    setAudioError('');
  }

  function resetBoard() {
    applyBoard(instantiatePreset(initialFactoryPreset), initialFactoryPreset.name);
  }

  function loadFactoryPreset(id: string) {
    const preset = FACTORY_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    applyBoard(instantiatePreset(preset), preset.name);
  }

  function loadUserPreset(preset: UserPreset) {
    applyBoard(instantiateUserPreset(preset), preset.name);
    setPresetName(preset.name);
  }

  function applyToneAgentBoard(board: ToneAgentBoardState, replaceSnapshots = false) {
    markBoardChanged();
    const nextValues = cloneValues(board.values);
    setChain(board.chain.map((item) => ({ ...item })));
    setSnapshots((current) => {
      if (replaceSnapshots) return { A: nextValues, B: cloneValues(nextValues) };
      const inactiveSnapshot = snapshot === 'A' ? 'B' : 'A';
      const boardIds = new Set(board.chain.map((item) => item.instanceId));
      const preservedInactive = Object.fromEntries(
        Object.entries(current[inactiveSnapshot])
          .filter(([instanceId]) => boardIds.has(instanceId))
          .map(([instanceId, values]) => [instanceId, { ...values }]),
      ) as Values;
      board.chain.forEach((item) => {
        if (!preservedInactive[item.instanceId]) preservedInactive[item.instanceId] = { ...(nextValues[item.instanceId] ?? {}) };
      });
      return snapshot === 'A'
        ? { A: nextValues, B: preservedInactive }
        : { A: preservedInactive, B: nextValues };
    });
    if (replaceSnapshots) setSnapshot('A');
    setSelected(board.chain[0]?.instanceId ?? '');
    setBypassed(new Set(board.bypassed));
    setSource({ ...board.source });
    setRouting({ ...board.routing });
    setAmp({ ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } });
    setOutput(board.output);
    setMode(board.monitorMode);
    setActivePresetName(board.name);
    setRender('idle');
    setAudioError('');
  }

  function restoreBoardUiState(state: BoardUiState) {
    const restored = cloneBoardUiState(state);
    markBoardChanged(false);
    setChain(restored.chain);
    setSnapshots(restored.snapshots);
    setSnapshot(restored.snapshot);
    setSelected(restored.selected);
    setBypassed(restored.bypassed);
    setSource(restored.source);
    setRouting(restored.routing);
    setAmp(restored.amp);
    setOutput(restored.output);
    setMode(restored.mode);
    setActivePresetName(restored.activePresetName);
    setRender('idle');
    setAudioError('');
  }

  async function runToneAgent() {
    const instruction = agentInput.trim();
    if (!instruction || agentBusy) return;
    agentTurnSerial.current += 1;
    const turnId = `tone-agent-${agentTurnSerial.current}`;
    const requestRevision = boardRevision.current;
    const undoBaseline = captureCurrentBoardUiState();
    const context = captureToneAgentBoard(toneAgentBoard);
    const history = agentTurns.flatMap<ToneAgentMessage>((turn) => {
      const result: ToneAgentMessage[] = [{ role: 'user', content: turn.userMessage }];
      if (turn.message) result.push({ role: 'assistant', content: turn.message });
      return result;
    }).slice(-12);
    const controller = new AbortController();
    agentAbort.current = controller;
    setAgentInput('');
    setAgentBusy(true);
    setAgentError('');
    setAgentTurns((current) => [...current, {
      id: turnId,
      userMessage: instruction,
      status: 'running',
      trace: [],
      actions: [],
    }]);

    try {
      const plan = await requestToneAgentStream({ instruction, context, history }, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type !== 'text_delta' && event.type !== 'trace') return;
          setAgentTurns((current) => current.map((turn) => {
            if (turn.id !== turnId) return turn;
            if (event.type === 'text_delta') return { ...turn, streamingMessage: `${turn.streamingMessage || ''}${event.delta}`.slice(-4_000) };
            const trace = turn.trace.some((step) => step.id === event.step.id) ? turn.trace : [...turn.trace, event.step].slice(-48);
            return { ...turn, trace };
          }));
        },
      });
      if (boardRevision.current !== requestRevision) {
        const staleMessage = '当前音色在 Agent 调整期间已发生变化，已忽略这次过期结果。';
        setAgentError(staleMessage);
        setAgentTurns((current) => current.map((turn) => turn.id === turnId ? {
          ...turn,
          status: 'failed',
          message: undefined,
          streamingMessage: undefined,
          trace: plan.trace.length ? plan.trace : turn.trace,
          actions: [],
          appliedCount: 0,
          applyErrors: [],
        } : turn));
        return;
      }
      const applied = applyToneAgentActions(context, plan.actions);
      if (applied.changed > 0) {
        const replaceSnapshots = plan.actions.some((action) => action.type === 'replace_board');
        applyToneAgentBoard(applied.board, replaceSnapshots);
        agentUndo.current.set(turnId, { baseline: undoBaseline, appliedRevision: boardRevision.current });
      }
      setAgentTurns((current) => current.map((turn) => turn.id === turnId ? {
        ...turn,
        status: 'completed',
        message: plan.message,
        streamingMessage: undefined,
        trace: plan.trace.length ? plan.trace : turn.trace,
        actions: plan.actions,
        appliedCount: applied.changed,
        applyErrors: applied.errors,
      } : turn));
    } catch (error) {
      if (isToneAgentAbort(error)) {
        setAgentTurns((current) => current.map((turn) => turn.id === turnId ? { ...turn, status: 'cancelled' } : turn));
      } else {
        const message = error instanceof Error ? error.message : '音色 Agent 暂时不可用。';
        // Login, quota and rate-limit rejections carry their own next step;
        // "just retry" only helps for transient failures.
        const accountRejection = error instanceof ToneAgentHttpError && [401, 402, 429].includes(error.status);
        setAgentError(accountRejection ? message : `${message} 你可以直接重试，当前音色没有被修改。`);
        setAgentTurns((current) => current.map((turn) => turn.id === turnId ? { ...turn, status: 'failed' } : turn));
      }
    } finally {
      if (agentAbort.current === controller) agentAbort.current = null;
      setAgentBusy(false);
    }
  }

  function stopToneAgent() {
    agentAbort.current?.abort();
  }

  function undoToneAgentTurn(turnId: string) {
    const entry = agentUndo.current.get(turnId);
    if (!entry) return;
    if (boardRevision.current !== entry.appliedRevision) {
      agentUndo.current.delete(turnId);
      setAgentError('当前音色已发生新的调整，无法撤销这次 Agent 操作。');
      return;
    }
    restoreBoardUiState(entry.baseline);
    agentUndo.current.delete(turnId);
    setAgentTurns((current) => current.map((turn) => turn.id === turnId ? { ...turn, undone: true } : turn));
  }

  function clearToneAgentConversation() {
    if (agentBusy) return;
    agentUndo.current.clear();
    setAgentTurns([]);
    setAgentError('');
  }

  function updateSource(next: SourceConfig) {
    markBoardChanged();
    setSource(next);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateValue(instanceId: string, controlId: string, value: number) {
    markBoardChanged();
    setSnapshots((current) => ({
      ...current,
      [snapshot]: {
        ...current[snapshot],
        [instanceId]: { ...current[snapshot][instanceId], [controlId]: value },
      },
    }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function addPedal(specId: string) {
    if (chain.length >= 16) {
      setAudioError('当前板面最多放 16 块效果器，请先移除一块。');
      return;
    }
    markBoardChanged();
    manualPedalSerial.current += 1;
    const instanceId = `${specId}-manual-${manualPedalSerial.current}`;
    const defaults = makeDefaultValues(specId);
    const lane = routing.mode === 'parallel' ? selectedLane : 'A';
    setChain((current) => [...current, { instanceId, specId, lane }]);
    setSnapshots((current) => ({ A: { ...current.A, [instanceId]: { ...defaults } }, B: { ...current.B, [instanceId]: { ...defaults } } }));
    setSelected(instanceId);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function getNamRepository() {
    const repository = namRepository.current ?? createBrowserNamModelRepository();
    namRepository.current = repository;
    return repository;
  }

  async function importNamModel(spec: EffectSpec, file?: File) {
    if (!spec.nam || !file || namImporting) return;
    const slotId = spec.nam.slotId;
    setNamImporting(slotId);
    setAudioError('');
    try {
      const parsed = parseNamModel(await file.text(), file.name);
      const record = createNamModelRecord(slotId, parsed);
      const repository = getNamRepository();
      await repository.save(record);
      setNamModels((current) => ({ ...current, [slotId]: record }));
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : 'NAM 模型导入失败');
    } finally {
      setNamImporting('');
    }
  }

  async function removeNamModel(spec: EffectSpec) {
    if (!spec.nam || namImporting) return;
    const slotId = spec.nam.slotId;
    setNamImporting(slotId);
    setAudioError('');
    try {
      const repository = getNamRepository();
      await repository.remove(slotId);
      setNamModels((current) => {
        const next = { ...current };
        delete next[slotId];
        return next;
      });
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : '无法删除本机 NAM 模型');
    } finally {
      setNamImporting('');
    }
  }

  function moveItem(instanceId: string, targetId: string) {
    if (instanceId === targetId) return;
    const from = chain.findIndex((item) => item.instanceId === instanceId);
    const to = chain.findIndex((item) => item.instanceId === targetId);
    if (from < 0 || to < 0) return;
    markBoardChanged();
    setChain((current) => {
      const currentFrom = current.findIndex((item) => item.instanceId === instanceId);
      const currentTo = current.findIndex((item) => item.instanceId === targetId);
      if (currentFrom < 0 || currentTo < 0) return current;
      const next = [...current];
      const moved = next.splice(currentFrom, 1)[0];
      next.splice(currentTo, 0, moved);
      return next;
    });
    setActivePresetName('已修改');
    setRender('idle');
  }

  function handleDrop(payload: string, targetId?: string) {
    if (payload.startsWith('add:')) addPedal(payload.slice(4));
    if (payload.startsWith('move:') && targetId) moveItem(payload.slice(5), targetId);
  }

  function moveSelected(direction: -1 | 1) {
    const target = selectedLaneItems[selectedLaneIndex + direction];
    if (target) moveItem(selected, target.instanceId);
  }

  function assignSelectedLane(lane: SignalLane) {
    if (selectedIndex < 0) return;
    markBoardChanged();
    setChain((current) => current.map((item) => item.instanceId === selected ? { ...item, lane } : item));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateRouting(next: Partial<RoutingConfig>) {
    markBoardChanged();
    setRouting((current) => ({ ...current, ...next }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function selectAmp(ampId: string) {
    markBoardChanged();
    setAmp((current) => ({ ...current, ampId, ampValues: makeDefaultAmpValues(ampId) }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function selectCab(cabId: string) {
    markBoardChanged();
    setAmp((current) => ({ ...current, cabId, cabValues: makeDefaultCabValues(cabId) }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateAmpValue(section: 'ampValues' | 'cabValues', controlId: string, value: number) {
    markBoardChanged();
    setAmp((current) => ({ ...current, [section]: { ...current[section], [controlId]: value } }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function openControlHelp(target: HelpTarget) {
    helpInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHelpTarget(target);
  }

  function closeControlHelp() {
    setHelpTarget(null);
    window.requestAnimationFrame(() => helpInvoker.current?.focus());
  }

  function removeSelected() {
    if (selectedIndex < 0) return;
    const removedInstanceId = selected;
    const nextSelected = chain[selectedIndex - 1]?.instanceId ?? chain[selectedIndex + 1]?.instanceId ?? '';
    markBoardChanged();
    setChain((current) => current.filter((item) => item.instanceId !== removedInstanceId));
    setSnapshots((current) => ({
      A: removeInstanceValues(current.A, removedInstanceId),
      B: removeInstanceValues(current.B, removedInstanceId),
    }));
    setBypassed((current) => {
      const next = new Set(current);
      next.delete(removedInstanceId);
      return next;
    });
    setSelected(nextSelected);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function toggleBypass(instanceId: string) {
    markBoardChanged();
    setBypassed((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      return next;
    });
    setActivePresetName('已修改');
    setRender('idle');
  }

  function selectSnapshot(next: 'A' | 'B') {
    if (snapshot === next) return;
    markBoardChanged(false);
    setSnapshot(next);
    setRender('idle');
  }

  /** Copies the active snapshot over the other one, so B can start as a variation of A. */
  function copySnapshotToOther() {
    const other = snapshot === 'A' ? 'B' : 'A';
    markBoardChanged();
    setSnapshots((current) => ({ ...current, [other]: cloneValues(current[snapshot]) }));
  }

  function setMonitorMode(next: 'dry' | 'wet') {
    if (mode === next) return;
    markBoardChanged(false);
    setMode(next);
    setRender('idle');
  }

  function updateOutput(next: number) {
    if (output === next) return;
    markBoardChanged(false);
    setOutput(next);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function toggleAmpBypass() {
    markBoardChanged();
    setAmp((current) => ({ ...current, bypassed: !current.bypassed }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  // Undo shortcuts; text fields keep their own undo. Re-subscribed each render
  // so the handlers see the current board.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"])')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undoBoard();
      else if (key === 'z' || key === 'y') redoBoard();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function toggleLiveInput() {
    if (liveInputBusy) return;
    if (liveInputActive) {
      const session = playback.current;
      if (session) setLiveInput(session, null);
      setLiveInputOn(false);
      return;
    }
    setLiveInputBusy(true);
    try {
      // Start the context inside the click (iOS needs the gesture), then ask for the input.
      if (!playback.requested) await togglePlayback();
      const stream = await requestInstrumentStream().catch(() => null);
      if (!stream) {
        setAudioError('无法打开实时输入：请允许浏览器使用声卡或麦克风。');
        return;
      }
      const session = playback.current;
      if (!session || !playback.requested) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setLiveInput(session, stream);
      setLiveInputOn(true);
    } finally {
      setLiveInputBusy(false);
    }
  }

  async function togglePlayback() {
    if (playbackLoading || playbackLoadingRef.current) return;
    setAudioError('');
    if (playback.requested) {
      setPlaying(false);
      try {
        await playback.stop();
      } catch {
        setAudioError('试听已停止，请重试。');
      }
      return;
    }
    playbackLoadingRef.current = true;
    setPlaybackLoading(true);
    try {
      const session = await playback.start(audioConfig);
      if (!session) return;
      session.onStatus = (status) => setEffectStatus(new Map(status));
      setEffectStatus(new Map(session.status));
      const latestConfig = latestAudioConfig.current;
      if (latestConfig !== audioConfig) await refreshLiveSession(session, latestConfig);
      if (playback.current !== session || !playback.requested) return;
      setPlaying(true);
    } catch {
      try {
        await playback.stop();
      } catch {
        // The controller invalidates a failed startup before disposal begins.
      }
      setPlaying(false);
      setAudioError('当前浏览器无法启动试听，请检查声音权限。');
    } finally {
      playbackLoadingRef.current = false;
      setPlaybackLoading(false);
    }
  }

  function saveCurrentPreset() {
    if (chain.length === 0) {
      setAudioError('空效果器链无法保存。');
      return;
    }
    try {
      const captured = captureUserPreset({ name: presetName, chain, values, bypassed, source, output, routing, amp });
      const next = [captured, ...userPresets].slice(0, 24);
      window.localStorage.setItem('sonic-board-user-presets', JSON.stringify(next));
      markBoardChanged(false);
      setUserPresets(next);
      setActivePresetName(captured.name);
      setSaveState('saved');
      setLibraryMode('presets');
      window.setTimeout(() => setSaveState('idle'), 1600);
    } catch {
      setAudioError('预设保存失败，请检查浏览器存储权限。');
    }
  }

  function deleteUserPreset(preset: UserPreset) {
    if (!window.confirm('删除“' + preset.name + '”？')) return;
    const next = userPresets.filter((entry) => entry.id !== preset.id);
    window.localStorage.setItem('sonic-board-user-presets', JSON.stringify(next));
    setUserPresets(next);
  }

  async function exportWav() {
    setRender('busy');
    setAudioError('');
    try {
      const blob = await renderBoardToWav(audioConfig);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'Sonic-Board-' + activePresetName + '-' + snapshot + '.wav';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setRender('ready');
    } catch {
      setRender('idle');
      setAudioError('音频导出失败，请减少长混响后再试。');
    }
  }

  function renderPedal(item: ChainItem) {
    const index = chain.findIndex((entry) => entry.instanceId === item.instanceId);
    return (
      <span className="chain-part" key={item.instanceId}>
        <DemoPedal
          item={item}
          index={index}
          values={values[item.instanceId] ?? {}}
          selected={selected === item.instanceId}
          bypassed={bypassed.has(item.instanceId)}
          namLoaded={!getEffectSpec(item.specId).nam || Boolean(namModels[getEffectSpec(item.specId).nam!.slotId])}
          engineStatus={playing ? effectStatus.get(item.instanceId) : undefined}
          tutorialEnabled={tutorialEnabled}
          onSelect={() => selectPedal(item.instanceId)}
          onValue={(id, value) => updateValue(item.instanceId, id, value)}
          onBypass={() => toggleBypass(item.instanceId)}
          onDrop={(payload) => handleDrop(payload, item.instanceId)}
          onHelp={openControlHelp}
        />
        <Cable />
      </span>
    );
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#pedalboard">跳到效果器板</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /></span><div><strong>SONIC BOARD</strong><small>盯鞋音色工作台</small></div></div>
        <div className="signal-note"><i /><span>当前音色：{activePresetName}</span></div>
        <div className="top-actions">
          <span>{EFFECT_SPECS.length} 块</span>
          <button
            type="button"
            className={'agent-open-button' + (agentOpen ? ' active' : '')}
            aria-label={agentOpen ? '关闭音色 Agent' : '打开音色 Agent'}
            aria-controls="tone-agent-dock"
            aria-expanded={agentOpen}
            onClick={() => setAgentOpen((current) => !current)}
          >音色 Agent</button>
          <label className="tutorial-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={tutorialEnabled}
              aria-label="参数教程"
              onChange={(event) => { setTutorialEnabled(event.target.checked); if (!event.target.checked) setHelpTarget(null); }}
            />
            <i aria-hidden="true"><b /></i><strong>参数教程</strong>
          </label>
          <button type="button" className="quiet" onClick={resetBoard}>重置</button>
          <button type="button" className="accent" onClick={saveCurrentPreset}>{saveState === 'saved' ? '已保存' : '保存音色'}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="library-panel" aria-label="音色与效果器库">
          <div className="panel-tabs" aria-label="库类型">
            <button type="button" className={libraryMode === 'effects' ? 'active' : ''} aria-pressed={libraryMode === 'effects'} onClick={() => setLibraryMode('effects')}>效果器 <b>{EFFECT_SPECS.length}</b></button>
            <button type="button" className={libraryMode === 'presets' ? 'active' : ''} aria-pressed={libraryMode === 'presets'} onClick={() => setLibraryMode('presets')}>音色 <b>{FACTORY_PRESETS.length + userPresets.length}</b></button>
            <button type="button" className={libraryMode === 'output' ? 'active' : ''} aria-pressed={libraryMode === 'output'} onClick={() => setLibraryMode('output')}>输出 <b>10</b></button>
          </div>

          {libraryMode === 'effects' ? (
            <div className="library-browser effects-browser">
              <div className="library-title"><div><span className="eyebrow">效果器库</span><h1>经典结构</h1></div><b>{library.length}</b></div>
              <p className="classic-note">经典名称仅用于说明参考对象；模型通过自动门禁，待真机验证。<a href="https://github.com/RelientS/sonic-board" target="_blank" rel="noreferrer">源码与验证说明</a></p>
              <label className="search"><span className="sr-only">搜索效果器</span><input placeholder="搜索名称、类型、风格或用途" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <div className="filters" aria-label="筛选效果器类型">{(['All', 'Dynamics', 'Tone', 'Drive', 'Mod', 'Delay', 'Space'] as const).map((entry) => <button key={entry} type="button" className={category === entry ? 'active' : ''} aria-pressed={category === entry} onClick={() => setCategory(entry)}>{categoryNames[entry]}</button>)}<button type="button" className={'circuit-filter' + (circuitOnly ? ' active' : '')} aria-pressed={circuitOnly} title="只看按原厂电路图逐元件仿真的效果器" onClick={() => setCircuitOnly((current) => !current)}>电路级</button></div>
              <StyleFilters value={styleFilter} onChange={setStyleFilter} />
              {library.length === 0 ? <p className="library-empty">没有匹配这个搜索、类型或风格的效果器。</p> : (
                <div className="library-list">{library.map((spec) => (
                  <article key={spec.id} className={'library-item' + (spec.nam ? ' has-nam' : '')} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', 'add:' + spec.id)}>
                    <MiniPedal spec={spec} />
                    <div><span>{categoryNames[spec.category]} · {spec.family}</span><strong>{spec.name}{isCircuitModelled(spec.id) && <em className="circuit-badge" title="按原厂电路图逐元件仿真（SPICE 校验）">CIRCUIT</em>}</strong><small>{spec.description}</small></div>
                    <button type="button" aria-label={'添加' + spec.name} onClick={() => addPedal(spec.id)}>添加</button>
                    {spec.nam && (() => {
                      const localModel = namModels[spec.nam.slotId];
                      const busy = namImporting === spec.nam.slotId;
                      return <div className="nam-local-actions">
                        <div className={'nam-model-state ' + (localModel ? 'loaded' : 'missing')}>
                          <strong>{localModel ? `本机已加载：${localModel.name}` : '本机未加载 NAM'}</strong>
                          <small>{localModel ? `${localModel.architecture} · ${Math.round(localModel.sampleRate / 100) / 10} kHz` : '加入链后安全直通，不会静音。'}</small>
                        </div>
                        <a href={spec.nam.sourceUrl} target="_blank" rel="noreferrer">下载 A1 Legacy</a>
                        <label className={'nam-import' + (busy ? ' disabled' : '')}>
                          <input
                            className="nam-file-input"
                            type="file"
                            accept=".nam"
                            disabled={busy}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              void importNamModel(spec, file);
                            }}
                          />
                          {busy ? '处理中…' : localModel ? '替换模型' : '导入 .nam'}
                        </label>
                        {localModel && <button type="button" className="nam-remove" disabled={busy} onClick={() => void removeNamModel(spec)}>移除</button>}
                        <small className="nam-private-note">{spec.nam.downloadHint} 文件只保存在当前浏览器，不上传。</small>
                      </div>;
                    })()}
                  </article>
                ))}</div>
              )}
            </div>
          ) : libraryMode === 'presets' ? (
            <div className="library-browser preset-browser">
              <div className="library-title"><div><span className="eyebrow">音色库</span><h1>风格起点</h1></div><b>{factoryPresetLibrary.length + userPresetLibrary.length}</b></div>
              <label className="search preset-search"><span className="sr-only">搜索音色</span><input placeholder="搜索名称、风格或用途" value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} /></label>
              <StyleFilters value={styleFilter} onChange={setStyleFilter} />
              <div className="preset-editor">
                <label><span>音色名称</span><input value={presetName} maxLength={28} onChange={(event) => setPresetName(event.target.value)} /></label>
                <button type="button" className="accent" onClick={saveCurrentPreset}>保存当前链</button>
              </div>
              <section className="preset-section">
                <h2>内置音色</h2>
                {factoryPresetLibrary.length === 0 ? <p className="preset-empty">没有匹配这个搜索或风格的内置音色。</p> : (
                  <div className="preset-list">{factoryPresetLibrary.map((preset) => {
                    const isCurrent = activePresetName === preset.name;
                    return <article className={'preset-card' + (isCurrent ? ' active' : '')} key={preset.id}>
                      <div>
                        <strong>{preset.name}</strong><small>{preset.description}</small>
                        <div className="preset-style-tags" role="list" aria-label={`${preset.name} 风格`}>{preset.styleTags?.map((tag) => <span key={tag} role="listitem" title={tag}>{STYLE_TAG_LABELS[tag]}</span>)}</div>
                        <span>{preset.chain.length} 块 · {preset.routing.mode === 'parallel' ? '双路并联' : '串联'} · {getAmpSpec(preset.amp.ampId).name}</span>
                      </div>
                      <button type="button" aria-label={'载入 ' + preset.name} aria-current={isCurrent ? 'true' : undefined} onClick={() => loadFactoryPreset(preset.id)}>载入</button>
                    </article>;
                  })}</div>
                )}
              </section>
              <section className="preset-section">
                <h2>我的音色</h2>
                {userPresets.length === 0 ? <p className="preset-empty">还没有保存在本机的音色。</p> : userPresetLibrary.length === 0 ? <p className="preset-empty">本机音色中没有匹配项。</p> : (
                  <div className="preset-list">{userPresetLibrary.map((preset) => {
                    const isCurrent = activePresetName === preset.name;
                    return <article className={'preset-card user' + (isCurrent ? ' active' : '')} key={preset.id}>
                      <div><strong>{preset.name}</strong><small>{preset.chain.map((item) => getEffectSpec(item.specId).name).join(' → ')}</small><span>{preset.chain.length} 块 · {preset.routing.mode === 'parallel' ? '双路并联' : '串联'} · {formatSourceConfig(preset.source)}</span></div>
                      <button type="button" aria-label={'载入 ' + preset.name} aria-current={isCurrent ? 'true' : undefined} onClick={() => loadUserPreset(preset)}>载入</button>
                      <button type="button" className="delete-preset" aria-label={'删除' + preset.name} onClick={() => deleteUserPreset(preset)}>删除</button>
                    </article>;
                  })}</div>
                )}
              </section>
            </div>
          ) : (
            <div className="library-browser output-browser">
              <div className="library-title"><div><span className="eyebrow">输出模块</span><h1>箱头与箱体</h1></div><b>{AMP_SPECS.length + CAB_SPECS.length}</b></div>
              <p className="model-disclosure">经典名称仅用于说明参考对象；当前均为非官方算法近似。</p>
              <button
                type="button"
                className={'amp-bypass' + (amp.bypassed ? ' active' : '')}
                aria-pressed={amp.bypassed}
                onClick={toggleAmpBypass}
              >{amp.bypassed ? '输出模拟已旁通' : '输出模拟已启用'}</button>
              <section className="output-section">
                <div className="section-heading"><h2>箱头</h2><span>{ampSpec.family}</span></div>
                <div className="model-list" role="radiogroup" aria-label="箱头模型">{AMP_SPECS.map((model) => (
                  <button key={model.id} type="button" role="radio" aria-checked={amp.ampId === model.id} className={amp.ampId === model.id ? 'active' : ''} onClick={() => selectAmp(model.id)}>
                    <i style={{ background: model.accent }} aria-hidden="true" /><span><strong>{model.name}</strong><small>{model.family}</small></span>
                  </button>
                ))}</div>
                <span className="model-method">{ampSpec.modeling}</span>
                <p className="model-description">{ampSpec.description}</p>
                <div className="output-knobs">{ampSpec.controls.map((control) => (
                  <KnobControl key={control.id} control={control} value={amp.ampValues[control.id] ?? control.defaultValue} disabled={amp.bypassed} tutorialEnabled={tutorialEnabled} ownerKind="amp" modelId={ampSpec.id} ownerName={ampSpec.name} onChange={(value) => updateAmpValue('ampValues', control.id, value)} onHelp={openControlHelp} />
                ))}</div>
              </section>
              <section className="output-section cab-section">
                <div className="section-heading"><h2>箱体</h2><span>{cabSpec.format}</span></div>
                <div className="cab-list" role="radiogroup" aria-label="箱体模型">{CAB_SPECS.map((model) => (
                  <button key={model.id} type="button" role="radio" aria-checked={amp.cabId === model.id} className={amp.cabId === model.id ? 'active' : ''} onClick={() => selectCab(model.id)}>
                    <strong>{model.name}</strong><small>{model.format}</small>
                  </button>
                ))}</div>
                <span className="model-method">{cabSpec.modeling}</span>
                <p className="model-description">{cabSpec.description}</p>
                {cabSpec.ir && <p className="model-credit">{cabSpec.ir.credit}</p>}
                <div className="output-knobs cab-knobs">{cabSpec.controls.map((control) => (
                  <KnobControl key={control.id} control={control} value={amp.cabValues[control.id] ?? control.defaultValue} disabled={amp.bypassed} tutorialEnabled={tutorialEnabled} ownerKind="cab" modelId={cabSpec.id} ownerName={cabSpec.name} onChange={(value) => updateAmpValue('cabValues', control.id, value)} onHelp={openControlHelp} />
                ))}</div>
              </section>
            </div>
          )}
        </aside>

        <section id="pedalboard" className={'board-stage ' + routing.mode} aria-label="效果器板画布" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleDrop(event.dataTransfer.getData('text/plain')); }}>
          <div className="board-toolbar">
            <div className="selected-meta">
              <span className="eyebrow">已选效果器</span>
              <div><strong>{selectedSpec?.name ?? '未选择'}</strong><small>{selectedSpec ? (routing.mode === 'parallel' ? selectedLane + ' 路 · ' : '') + categoryNames[selectedSpec.category] + ' · ' + selectedSpec.family + ' · ' + (bypassed.has(selected) ? '已旁通' : '已启用') : ''}</small></div>
              <span className="current-tone-indicator" aria-live="polite"><small>当前音色</small><strong>{activePresetName}</strong></span>
            </div>
            <div className="edit-actions">
              <div className="history-actions"><button type="button" aria-label="撤销" title="撤销（⌘/Ctrl+Z）" disabled={!historyState.canUndo} onClick={undoBoard}>↶</button><button type="button" aria-label="重做" title="重做（⇧⌘/Ctrl+Shift+Z）" disabled={!historyState.canRedo} onClick={redoBoard}>↷</button></div>
              <div className="move-actions"><button type="button" disabled={selectedLaneIndex <= 0} onClick={() => moveSelected(-1)}>前移</button><button type="button" disabled={selectedLaneIndex < 0 || selectedLaneIndex >= selectedLaneItems.length - 1} onClick={() => moveSelected(1)}>后移</button><button type="button" disabled={selectedIndex < 0} onClick={removeSelected}>移除</button></div>
              {routing.mode === 'parallel' && <div className="lane-actions" aria-label="分配已选效果器到通道"><span>放到</span>{(['A', 'B'] as const).map((lane) => <button key={lane} type="button" className={selectedLane === lane ? 'active' : ''} aria-pressed={selectedLane === lane} disabled={selectedIndex < 0} onClick={() => assignSelectedLane(lane)}>{lane} 路</button>)}</div>}
            </div>
            <div className="routing-tools">
              <div className="segments route-mode" aria-label="串联或并联">{(['serial', 'parallel'] as const).map((entry) => <button key={entry} type="button" className={routing.mode === entry ? 'active' : ''} aria-pressed={routing.mode === entry} onClick={() => updateRouting({ mode: entry })}>{entry === 'serial' ? '串联' : '双路并联'}</button>)}</div>
              <label><span>A / B 平衡</span><input type="range" min="0" max="100" value={routing.blend} disabled={routing.mode === 'serial'} aria-label="A B 通道平衡" onChange={(event) => updateRouting({ blend: Number(event.target.value) })} /></label>
              <label><span>立体声宽度</span><input type="range" min="0" max="100" value={routing.spread} disabled={routing.mode === 'serial'} aria-label="立体声宽度" onChange={(event) => updateRouting({ spread: Number(event.target.value) })} /></label>
            </div>
            <div className="zoom"><button type="button" aria-label="缩小板面" onClick={() => setZoom((value) => Math.max(.7, value - .08))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="放大板面" onClick={() => setZoom((value) => Math.min(1.1, value + .08))}>+</button></div>
          </div>
          <div className="board-scroll">
            {routing.mode === 'parallel' && <p className="board-pan-hint" aria-live="polite">左右滑动查看 A / B 路效果器</p>}
            <div className={'board-frame ' + routing.mode}><div className={'chain ' + routing.mode} style={{ '--scale': zoom } as CSSProperties}>
            <div className="input-box">输入</div><Cable />
            {routing.mode === 'serial' ? chain.map(renderPedal) : (
              <>
                <div className="route-node splitter"><span>分流</span><b>A/B</b></div><Cable />
                <div className="lane-stack">
                  {(['A', 'B'] as const).map((lane) => {
                    const laneItems = chain.filter((item) => (item.lane ?? 'A') === lane);
                    return <div className={'lane-row lane-' + lane.toLowerCase()} key={lane}><span className="lane-label">{lane} 路</span><Cable />{laneItems.map(renderPedal)}{laneItems.length === 0 && <span className="lane-empty">空通道（干声直通）</span>}</div>;
                  })}
                </div>
                <Cable /><div className="route-node merger"><span>合流</span><b>Σ</b></div><Cable />
              </>
            )}
            <button type="button" className={'amp' + (amp.bypassed ? ' is-bypassed' : '')} onClick={() => setLibraryMode('output')}><div><span>{amp.bypassed ? '已旁通' : '箱头 + 箱体'}</span><strong>{ampSpec.name}</strong><small>{cabSpec.name}</small></div><i /></button>
          </div>{chain.length === 0 && <p className="empty">从左侧添加效果器，或载入一个音色。</p>}</div></div>
        </section>
      </div>

      <footer className="transport">
        <button className="source-trigger" type="button" aria-label="选择清音输入" onClick={() => setSourcePickerOpen(true)}><span>清音输入</span><strong>{formatSourceConfig(source)}</strong><small>{getChordProgression(source.progression).name}</small></button>
        <button className={'play' + (playing ? ' active' : '') + (playbackLoading ? ' is-loading' : '')} type="button" aria-label={playbackLoading ? '正在加载试听' : playing ? '停止试听' : '开始试听'} aria-busy={playbackLoading} disabled={playbackLoading} onClick={() => void togglePlayback()}>{playbackLoading ? '…' : playing ? '■' : '▶'}</button>
        <PlaybackWaveform playback={playback} playing={playing} loading={playbackLoading} />
        <button type="button" className={'live-input' + (liveInputActive ? ' active' : '')} aria-pressed={liveInputActive} disabled={liveInputBusy || playbackLoading} title="用声卡或麦克风输入真实吉他（请戴耳机，避免啸叫）" onClick={() => void toggleLiveInput()}>{liveInputActive ? '● 实时输入' : '实时输入'}</button>
        <div className="segments" aria-label="干声或效果声">{(['dry', 'wet'] as const).map((entry) => <button key={entry} type="button" className={mode === entry ? 'active' : ''} aria-pressed={mode === entry} onClick={() => setMonitorMode(entry)}>{entry === 'dry' ? '干声' : '效果'}</button>)}</div>
        <div className="segments ab" aria-label="参数快照 A 或 B">{(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => selectSnapshot(entry)}>快照 {entry}</button>)}<button type="button" className="ab-copy" title={'用快照 ' + snapshot + ' 覆盖快照 ' + (snapshot === 'A' ? 'B' : 'A')} onClick={copySnapshotToOther}>{snapshot}→{snapshot === 'A' ? 'B' : 'A'}</button></div>
        <label className="output"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => updateOutput(Number(event.target.value))} /></label>
        <button type="button" className="render" disabled={render === 'busy'} onClick={() => void exportWav()}>{render === 'busy' ? '正在导出…' : render === 'ready' ? '已下载' : '导出 WAV'}</button>
        {audioError && <span className="audio-error" role="alert">{audioError}</span>}
        <span className="sr-only" role="status" aria-live="polite">{playbackLoading ? '正在加载试听，请稍候；重复点击不会中断加载。' : render === 'ready' ? 'WAV 音频已下载' : saveState === 'saved' ? '音色已保存在当前浏览器' : ''}</span>
      </footer>
      <ControlHelpDialog target={helpTarget} onClose={closeControlHelp} />
      <ToneAgentDock
        open={agentOpen}
        input={agentInput}
        turns={agentTurns}
        busy={agentBusy}
        error={agentError}
        boardSummary={`${chain.length} 块 · ${routing.mode === 'parallel' ? '双路并联' : '串联'} · ${ampSpec.name}`}
        onOpenChange={setAgentOpen}
        onInputChange={setAgentInput}
        onSubmit={() => void runToneAgent()}
        onStop={stopToneAgent}
        onUndo={undoToneAgentTurn}
        onClear={clearToneAgentConversation}
      />
      <SourcePickerDialog open={sourcePickerOpen} source={source} onChange={updateSource} onClose={() => setSourcePickerOpen(false)} />
    </main>
  );
}
