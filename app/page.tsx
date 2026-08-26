'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  createLiveSession,
  disposeLiveSession,
  refreshLiveSession,
  renderBoardToWav,
  type BoardAudioConfig,
  type LiveAudioSession,
} from './audio/audio-engine';
import type { AudioChainItem, RoutingConfig, SignalLane } from './audio/audio-core';
import {
  CHORD_PROGRESSIONS,
  GUITAR_VOICES,
  PERFORMANCE_SPECS,
  formatSourceConfig,
  getChordProgression,
  type SourceConfig,
} from './audio/source-catalog';
import { planToneRequest, type ToneAgentPlan } from './agent/tone-agent';
import { normalizeRemoteTonePlan } from './agent/tone-agent-api';
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
  formatControlValue,
  getEffectSpec,
  instantiatePreset,
  makeDefaultValues,
  type ControlSpec,
  type EffectCategory,
  type EffectSpec,
  type InstantiatedPreset,
} from './effects/catalog';
import { getControlHelp, type ControlOwnerKind } from './effects/control-help';
import { getPedalControlLabel } from './effects/control-labels';
import {
  captureUserPreset,
  instantiateUserPreset,
  parseUserPresets,
  type UserPreset,
} from './effects/user-presets';

type ChainItem = AudioChainItem;
type Values = Record<string, Record<string, number>>;
type LibraryMode = 'effects' | 'presets' | 'output';
type AgentStatus = 'idle' | 'thinking' | 'applied' | 'fallback';
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
const agentExamples = [
  '宽阔立体声的反向音墙，厚但中频别丢',
  '干净明亮的分解和弦，合唱加磁带回声',
  '温暖复古的小调和弦，慢速相位和磁带感',
];
const initialFactoryPreset = FACTORY_PRESETS.find((preset) => preset.id === 'reverse-wall') ?? FACTORY_PRESETS[0];
const initialBoard = instantiatePreset(initialFactoryPreset);

function cloneValues(values: Values) {
  return Object.fromEntries(Object.entries(values).map(([id, controls]) => [id, { ...controls }]));
}

function makeSnapshots(board: InstantiatedPreset) {
  const a = cloneValues(board.values);
  const b = cloneValues(board.values);
  board.chain.forEach((item) => {
    const current = b[item.instanceId];
    if ('mix' in current) current.mix = Math.min(100, current.mix + 9);
    if ('sustain' in current) current.sustain = Math.min(100, current.sustain + 10);
    if ('gain' in current) current.gain = Math.min(100, current.gain + 8);
    if ('distortion' in current) current.distortion = Math.min(100, current.distortion + 8);
    if ('motion' in current) current.motion = Math.min(100, current.motion + 12);
  });
  return { A: a, B: b };
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
  const style = { '--angle': String(-138 + value * 2.76) + 'deg' } as CSSProperties;
  return (
    <div className={'knob-control' + (tutorialEnabled ? ' is-tutorial' : '')}>
      <span className="knob-label-row"><span className="knob-label">{displayLabel ?? control.label}</span>{tutorialEnabled && (
        <button
          className="help-trigger"
          type="button"
          aria-label={`查看${ownerName}的${control.label}旋钮说明`}
          onClick={(event) => { event.stopPropagation(); onHelp({ kind: ownerKind, modelId, ownerName, control }); }}
        >?</button>
      )}</span>
      <label className="knob-hit">
        <span className="knob" style={style} aria-hidden="true"><span /></span>
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          disabled={disabled}
          aria-label={control.label + '，' + formatControlValue(control, value)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      <span className="knob-readout">{formatControlValue(control, value)}</span>
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

function ToneAgentDialog({ open, prompt, result, status, error, onPrompt, onRun, onClose }: {
  open: boolean;
  prompt: string;
  result: ToneAgentPlan | null;
  status: AgentStatus;
  error: string;
  onPrompt: (value: string) => void;
  onRun: () => void | Promise<void>;
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
      className="agent-dialog"
      aria-labelledby="agent-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="agent-sheet">
        <header>
          <div><span>AI 音色规划 · gpt-5.6-terra</span><h2 id="agent-title">音色 Agent</h2></div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); onRun(); }}>
          <label className="agent-prompt">
            <span>描述你想要的声音</span>
            <textarea
              value={prompt}
              maxLength={240}
              placeholder="例如：慢速、宽阔的反向音墙，和弦要清楚，中频不要被挖空"
              onChange={(event) => onPrompt(event.target.value)}
            />
          </label>
          <div className="agent-examples" aria-label="需求示例">
            {agentExamples.map((example) => <button key={example} type="button" onClick={() => onPrompt(example)}>{example}</button>)}
          </div>
          <button className="agent-run" type="submit" disabled={status === 'thinking' || !prompt.trim()}>{status === 'thinking' ? '正在调音…' : '生成并应用'}</button>
        </form>
        {error && <p className="agent-warning" role="status">{error}</p>}
        {result && (
          <section className="agent-result" role="status" aria-live="polite">
            <div><span>{status === 'fallback' ? '本地兜底已应用' : 'AI 已应用'}</span><strong>{result.name}</strong></div>
            <p>{result.summary}</p>
            <ol>{result.preset.chain.map((item) => <li key={`${item.lane ?? 'A'}-${item.specId}`}>{item.lane && result.preset.routing.mode === 'parallel' ? `${item.lane} 路 · ` : ''}{getEffectSpec(item.specId).name}</li>)}</ol>
            <ul>{result.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
          </section>
        )}
      </div>
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
            真实采样 · CC0 · <a href="https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html" target="_blank" rel="noreferrer">FreePats</a>
            {' / '}
            <a href="https://github.com/sfzinstruments/karoryfer.black-and-green-guitars" target="_blank" rel="noreferrer">{'Black & Green Guitars'}</a>
          </p>
        </section>
        <section>
          <h3>演奏方式</h3>
          <div className="source-choice-grid performance" role="radiogroup" aria-label="演奏方式">
            {PERFORMANCE_SPECS.map((performance) => <button key={performance.id} type="button" role="radio" aria-checked={source.performance === performance.id} className={source.performance === performance.id ? 'active' : ''} onClick={() => onChange({ ...source, performance: performance.id })}><strong>{performance.name}</strong></button>)}
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

function DemoPedal({ item, index, values, selected, bypassed, tutorialEnabled, onSelect, onValue, onBypass, onDrop, onHelp }: {
  item: ChainItem;
  index: number;
  values: Record<string, number>;
  selected: boolean;
  bypassed: boolean;
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
      onClick={onSelect}
      onDragStart={(event) => event.dataTransfer.setData('text/plain', 'move:' + item.instanceId)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/plain')); }}
    >
      <span className="order-badge">{index + 1}</span>
      <div className={'pedal-body' + (manyControls ? ' has-many' : '')} style={style}>
        <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
        <span className="jack jack-left" /><span className="jack jack-right" />
        <div className="pedal-maker">{spec.maker}</div>
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
  const [search, setSearch] = useState('');
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
  const [progress, setProgress] = useState(0);
  const [render, setRender] = useState<'idle' | 'busy' | 'ready'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [tutorialEnabled, setTutorialEnabled] = useState(false);
  const [helpTarget, setHelpTarget] = useState<HelpTarget | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState(agentExamples[0]);
  const [agentResult, setAgentResult] = useState<ToneAgentPlan | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentError, setAgentError] = useState('');
  const [audioError, setAudioError] = useState('');
  const audio = useRef<LiveAudioSession | null>(null);
  const helpInvoker = useRef<HTMLElement | null>(null);
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
      const queryMatches = !query || [spec.name, spec.maker, spec.family, spec.description].some((text) => text.toLowerCase().includes(query));
      return categoryMatches && queryMatches;
    });
  }, [category, search]);

  const audioConfig = useMemo<BoardAudioConfig>(() => ({
    chain,
    values,
    bypassed: [...bypassed],
    source,
    mode,
    output,
    routing,
    amp,
  }), [chain, values, bypassed, source, mode, output, routing, amp]);

  useEffect(() => {
    setUserPresets(parseUserPresets(window.localStorage.getItem('sonic-board-user-presets')));
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setProgress((value) => (value + 1.35) % 100), 80);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (!playing || !audio.current) return;
    const timer = window.setTimeout(() => {
      if (audio.current) void refreshLiveSession(audio.current, audioConfig);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [audioConfig, playing]);

  useEffect(() => () => { void disposeLiveSession(audio.current); }, []);

  function applyBoard(board: InstantiatedPreset, name: string) {
    setChain(board.chain);
    setSnapshots(makeSnapshots(board));
    setSnapshot('A');
    setSelected(board.chain[0]?.instanceId ?? '');
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

  async function runToneAgent() {
    const prompt = agentPrompt.trim();
    if (!prompt || agentStatus === 'thinking') return;
    setAgentStatus('thinking');
    setAgentError('');

    let plan: ToneAgentPlan | null = null;
    try {
      const response = await fetch('/api/tone-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) throw new Error('agent unavailable');
      const payload = await response.json() as { plan?: unknown };
      plan = normalizeRemoteTonePlan(payload.plan);
      if (!plan) throw new Error('invalid plan');
      setAgentStatus('applied');
    } catch {
      plan = planToneRequest(prompt);
      setAgentStatus('fallback');
      setAgentError('模型暂时没有返回可用方案，已用本地音色规则生成同类效果器链。');
    }

    setAgentResult(plan);
    applyBoard(instantiatePreset(plan.preset), `Agent · ${plan.name}`);
    setMode('wet');
  }

  function updateSource(next: SourceConfig) {
    setSource(next);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateValue(instanceId: string, controlId: string, value: number) {
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
    const instanceId = specId + '-' + Date.now();
    const defaults = makeDefaultValues(specId);
    const lane = routing.mode === 'parallel' ? selectedLane : 'A';
    setChain((current) => [...current, { instanceId, specId, lane }]);
    setSnapshots((current) => ({ A: { ...current.A, [instanceId]: { ...defaults } }, B: { ...current.B, [instanceId]: { ...defaults } } }));
    setSelected(instanceId);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function moveItem(instanceId: string, targetId: string) {
    if (instanceId === targetId) return;
    setChain((current) => {
      const from = current.findIndex((item) => item.instanceId === instanceId);
      const to = current.findIndex((item) => item.instanceId === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const moved = next.splice(from, 1)[0];
      next.splice(to, 0, moved);
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
    setChain((current) => current.map((item) => item.instanceId === selected ? { ...item, lane } : item));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateRouting(next: Partial<RoutingConfig>) {
    setRouting((current) => ({ ...current, ...next }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function selectAmp(ampId: string) {
    setAmp((current) => ({ ...current, ampId, ampValues: makeDefaultAmpValues(ampId) }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function selectCab(cabId: string) {
    setAmp((current) => ({ ...current, cabId, cabValues: makeDefaultCabValues(cabId) }));
    setActivePresetName('已修改');
    setRender('idle');
  }

  function updateAmpValue(section: 'ampValues' | 'cabValues', controlId: string, value: number) {
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
    const nextSelected = chain[selectedIndex - 1]?.instanceId ?? chain[selectedIndex + 1]?.instanceId ?? '';
    setChain((current) => current.filter((item) => item.instanceId !== selected));
    setSelected(nextSelected);
    setActivePresetName('已修改');
    setRender('idle');
  }

  function toggleBypass(instanceId: string) {
    setBypassed((current) => {
      const next = new Set(current);
      next.has(instanceId) ? next.delete(instanceId) : next.add(instanceId);
      return next;
    });
    setActivePresetName('已修改');
    setRender('idle');
  }

  async function togglePlayback() {
    setAudioError('');
    if (playing) {
      setPlaying(false);
      setProgress(0);
      await disposeLiveSession(audio.current);
      audio.current = null;
      return;
    }
    await disposeLiveSession(audio.current);
    try {
      audio.current = await createLiveSession(audioConfig);
      setProgress(0);
      setPlaying(true);
    } catch {
      audio.current = null;
      setAudioError('当前浏览器无法启动试听，请检查声音权限。');
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
      document.body.append(anchor);
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
          tutorialEnabled={tutorialEnabled}
          onSelect={() => setSelected(item.instanceId)}
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
          <button type="button" className="agent-open-button" aria-label="打开音色 Agent" onClick={() => setAgentOpen(true)}>音色 Agent</button>
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
              <p className="classic-note">经典型号名用于快速辨识；本站为风格建模，并非品牌官方复刻。</p>
              <label className="search"><span className="sr-only">搜索效果器</span><input placeholder="搜索名称、类型或用途" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <div className="filters" aria-label="筛选效果器类型">{(['All', 'Dynamics', 'Tone', 'Drive', 'Mod', 'Delay', 'Space'] as const).map((entry) => <button key={entry} type="button" className={category === entry ? 'active' : ''} aria-pressed={category === entry} onClick={() => setCategory(entry)}>{categoryNames[entry]}</button>)}</div>
              <div className="library-list">{library.map((spec) => (
                <article key={spec.id} className="library-item" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', 'add:' + spec.id)}>
                  <MiniPedal spec={spec} />
                  <div><span>{categoryNames[spec.category]} · {spec.family}</span><strong>{spec.name}</strong><small>{spec.description}</small></div>
                  <button type="button" aria-label={'添加' + spec.name} onClick={() => addPedal(spec.id)}>添加</button>
                </article>
              ))}</div>
            </div>
          ) : libraryMode === 'presets' ? (
            <div className="library-browser preset-browser">
              <div className="library-title"><div><span className="eyebrow">音色库</span><h1>盯鞋起点</h1></div><b>{FACTORY_PRESETS.length + userPresets.length}</b></div>
              <div className="preset-editor">
                <label><span>音色名称</span><input value={presetName} maxLength={28} onChange={(event) => setPresetName(event.target.value)} /></label>
                <button type="button" className="accent" onClick={saveCurrentPreset}>保存当前链</button>
              </div>
              <section className="preset-section">
                <h2>内置音色</h2>
                <div className="preset-list">{FACTORY_PRESETS.map((preset) => (
                  <article className="preset-card" key={preset.id}>
                    <div><strong>{preset.name}</strong><small>{preset.description}</small><span>{preset.chain.length} 块 · {preset.routing.mode === 'parallel' ? '双路并联' : '串联'} · {getAmpSpec(preset.amp.ampId).name}</span></div>
                    <button type="button" onClick={() => loadFactoryPreset(preset.id)}>载入</button>
                  </article>
                ))}</div>
              </section>
              <section className="preset-section">
                <h2>我的音色</h2>
                {userPresets.length === 0 ? <p className="preset-empty">还没有保存在本机的音色。</p> : (
                  <div className="preset-list">{userPresets.map((preset) => (
                    <article className="preset-card user" key={preset.id}>
                      <div><strong>{preset.name}</strong><small>{preset.chain.map((item) => getEffectSpec(item.specId).name).join(' → ')}</small><span>{preset.chain.length} 块 · {preset.routing.mode === 'parallel' ? '双路并联' : '串联'} · {formatSourceConfig(preset.source)}</span></div>
                      <button type="button" onClick={() => loadUserPreset(preset)}>载入</button>
                      <button type="button" className="delete-preset" aria-label={'删除' + preset.name} onClick={() => deleteUserPreset(preset)}>删除</button>
                    </article>
                  ))}</div>
                )}
              </section>
            </div>
          ) : (
            <div className="library-browser output-browser">
              <div className="library-title"><div><span className="eyebrow">输出模块</span><h1>箱头与箱体</h1></div><b>{AMP_SPECS.length + CAB_SPECS.length}</b></div>
              <button
                type="button"
                className={'amp-bypass' + (amp.bypassed ? ' active' : '')}
                aria-pressed={amp.bypassed}
                onClick={() => { setAmp((current) => ({ ...current, bypassed: !current.bypassed })); setRender('idle'); }}
              >{amp.bypassed ? '输出模拟已旁通' : '输出模拟已启用'}</button>
              <section className="output-section">
                <div className="section-heading"><h2>箱头</h2><span>{ampSpec.family}</span></div>
                <div className="model-list" role="radiogroup" aria-label="箱头模型">{AMP_SPECS.map((model) => (
                  <button key={model.id} type="button" role="radio" aria-checked={amp.ampId === model.id} className={amp.ampId === model.id ? 'active' : ''} onClick={() => selectAmp(model.id)}>
                    <i style={{ background: model.accent }} aria-hidden="true" /><span><strong>{model.name}</strong><small>{model.family}</small></span>
                  </button>
                ))}</div>
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
                <p className="model-description">{cabSpec.description}</p>
                <div className="output-knobs cab-knobs">{cabSpec.controls.map((control) => (
                  <KnobControl key={control.id} control={control} value={amp.cabValues[control.id] ?? control.defaultValue} disabled={amp.bypassed} tutorialEnabled={tutorialEnabled} ownerKind="cab" modelId={cabSpec.id} ownerName={cabSpec.name} onChange={(value) => updateAmpValue('cabValues', control.id, value)} onHelp={openControlHelp} />
                ))}</div>
              </section>
            </div>
          )}
        </aside>

        <section id="pedalboard" className="board-stage" aria-label="效果器板画布" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleDrop(event.dataTransfer.getData('text/plain')); }}>
          <div className="board-toolbar">
            <div className="selected-meta">
              <span className="eyebrow">已选效果器</span>
              <div><strong>{selectedSpec?.name ?? '未选择'}</strong><small>{selectedSpec ? (routing.mode === 'parallel' ? selectedLane + ' 路 · ' : '') + categoryNames[selectedSpec.category] + ' · ' + selectedSpec.family + ' · ' + (bypassed.has(selected) ? '已旁通' : '已启用') : ''}</small></div>
            </div>
            <div className="edit-actions">
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
          <div className="board-scroll"><div className={'board-frame ' + routing.mode}><div className={'chain ' + routing.mode} style={{ '--scale': zoom } as CSSProperties}>
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
        <button className={'play' + (playing ? ' active' : '')} type="button" aria-label={playing ? '停止试听' : '开始试听'} onClick={() => void togglePlayback()}>{playing ? '■' : '▶'}</button>
        <div className="waveform" aria-label={'试听进度 ' + Math.round(progress) + '%'}><i style={{ width: String(progress) + '%' }} />{wave.map((height, index) => <b key={String(height) + '-' + String(index)} style={{ height: String(height) + '%' }} />)}</div>
        <div className="segments" aria-label="干声或效果声">{(['dry', 'wet'] as const).map((entry) => <button key={entry} type="button" className={mode === entry ? 'active' : ''} aria-pressed={mode === entry} onClick={() => { setMode(entry); setRender('idle'); }}>{entry === 'dry' ? '干声' : '效果'}</button>)}</div>
        <div className="segments ab" aria-label="参数快照 A 或 B">{(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => { setSnapshot(entry); setRender('idle'); }}>快照 {entry}</button>)}</div>
        <label className="output"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => { setOutput(Number(event.target.value)); setRender('idle'); }} /></label>
        <button type="button" className="render" disabled={render === 'busy'} onClick={() => void exportWav()}>{render === 'busy' ? '正在导出…' : render === 'ready' ? '已下载' : '导出 WAV'}</button>
        {audioError && <span className="audio-error" role="alert">{audioError}</span>}
        <span className="sr-only" role="status" aria-live="polite">{render === 'ready' ? 'WAV 音频已下载' : saveState === 'saved' ? '音色已保存在当前浏览器' : ''}</span>
      </footer>
      <ControlHelpDialog target={helpTarget} onClose={closeControlHelp} />
      <ToneAgentDialog open={agentOpen} prompt={agentPrompt} result={agentResult} status={agentStatus} error={agentError} onPrompt={setAgentPrompt} onRun={runToneAgent} onClose={() => setAgentOpen(false)} />
      <SourcePickerDialog open={sourcePickerOpen} source={source} onChange={updateSource} onClose={() => setSourcePickerOpen(false)} />
    </main>
  );
}
