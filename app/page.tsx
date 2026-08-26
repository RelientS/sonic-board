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
import type { SourceKind } from './audio/audio-core';
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
import {
  captureUserPreset,
  instantiateUserPreset,
  parseUserPresets,
  type UserPreset,
} from './effects/user-presets';

type ChainItem = { instanceId: string; specId: string };
type Values = Record<string, Record<string, number>>;
type LibraryMode = 'effects' | 'presets';

const categoryNames: Record<'All' | EffectCategory, string> = {
  All: '全部',
  Dynamics: '动态',
  Tone: '音色',
  Drive: '增益',
  Mod: '调制',
  Delay: '延迟',
  Space: '空间',
};
const sourceNames: Record<SourceKind, string> = { chords: '清音和弦', arpeggio: '分解和弦', lead: '单音旋律' };
const wave = [18, 42, 72, 34, 85, 52, 66, 28, 90, 46, 74, 38, 82, 56, 26, 68, 88, 44, 72, 32, 62, 94, 48, 76, 36, 84, 54, 24, 70, 91, 42, 68, 34, 80, 52, 74, 30, 63, 87, 46];
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

function KnobControl({ control, value, disabled, onChange }: {
  control: ControlSpec;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const style = { '--angle': String(-138 + value * 2.76) + 'deg' } as CSSProperties;
  return (
    <label className="knob-control">
      <span className="knob-label">{control.label}</span>
      <span className="knob-hit">
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
      </span>
      <span className="knob-readout">{formatControlValue(control, value)}</span>
    </label>
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

function DemoPedal({ item, index, values, selected, bypassed, onSelect, onValue, onBypass, onDrop }: {
  item: ChainItem;
  index: number;
  values: Record<string, number>;
  selected: boolean;
  bypassed: boolean;
  onSelect: () => void;
  onValue: (id: string, value: number) => void;
  onBypass: () => void;
  onDrop: (payload: string) => void;
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
              value={values[control.id] ?? control.defaultValue}
              disabled={bypassed}
              onChange={(value) => onValue(control.id, value)}
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
  const [source, setSource] = useState<SourceKind>(initialBoard.source);
  const [output, setOutput] = useState(initialBoard.output);
  const [activePresetName, setActivePresetName] = useState(initialFactoryPreset.name);
  const [presetName, setPresetName] = useState('我的音色');
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [render, setRender] = useState<'idle' | 'busy' | 'ready'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [audioError, setAudioError] = useState('');
  const audio = useRef<LiveAudioSession | null>(null);
  const values = snapshots[snapshot];
  const selectedIndex = chain.findIndex((item) => item.instanceId === selected);
  const selectedSpec = selectedIndex >= 0 ? getEffectSpec(chain[selectedIndex].specId) : null;

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
  }), [chain, values, bypassed, source, mode, output]);

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
      if (audio.current) refreshLiveSession(audio.current, audioConfig);
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
    if (chain.length >= 12) {
      setAudioError('一条链最多放 12 块效果器，请先移除一块。');
      return;
    }
    const instanceId = specId + '-' + Date.now();
    const defaults = makeDefaultValues(specId);
    setChain((current) => [...current, { instanceId, specId }]);
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
    const target = chain[selectedIndex + direction];
    if (target) moveItem(selected, target.instanceId);
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
      const captured = captureUserPreset({ name: presetName, chain, values, bypassed, source, output });
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

  return (
    <main className="app-shell">
      <a className="skip-link" href="#pedalboard">跳到效果器板</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /></span><div><strong>SONIC BOARD</strong><small>盯鞋音色工作台</small></div></div>
        <div className="signal-note"><i /><span>当前音色：{activePresetName}</span></div>
        <div className="top-actions">
          <span>{EFFECT_SPECS.length} 块</span>
          <button type="button" className="quiet" onClick={resetBoard}>重置</button>
          <button type="button" className="accent" onClick={saveCurrentPreset}>{saveState === 'saved' ? '已保存' : '保存音色'}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="library-panel" aria-label="音色与效果器库">
          <div className="panel-tabs" aria-label="库类型">
            <button type="button" className={libraryMode === 'effects' ? 'active' : ''} aria-pressed={libraryMode === 'effects'} onClick={() => setLibraryMode('effects')}>效果器 <b>{EFFECT_SPECS.length}</b></button>
            <button type="button" className={libraryMode === 'presets' ? 'active' : ''} aria-pressed={libraryMode === 'presets'} onClick={() => setLibraryMode('presets')}>音色 <b>{FACTORY_PRESETS.length + userPresets.length}</b></button>
          </div>

          {libraryMode === 'effects' ? (
            <>
              <div className="library-title"><div><span className="eyebrow">效果器库</span><h1>经典结构</h1></div><b>{library.length}</b></div>
              <label className="search"><span className="sr-only">搜索效果器</span><input placeholder="搜索名称、类型或用途" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <div className="filters" aria-label="筛选效果器类型">{(['All', 'Dynamics', 'Tone', 'Drive', 'Mod', 'Delay', 'Space'] as const).map((entry) => <button key={entry} type="button" className={category === entry ? 'active' : ''} aria-pressed={category === entry} onClick={() => setCategory(entry)}>{categoryNames[entry]}</button>)}</div>
              <div className="library-list">{library.map((spec) => (
                <article key={spec.id} className="library-item" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', 'add:' + spec.id)}>
                  <MiniPedal spec={spec} />
                  <div><span>{categoryNames[spec.category]} · {spec.family}</span><strong>{spec.name}</strong><small>{spec.description}</small></div>
                  <button type="button" aria-label={'添加' + spec.name} onClick={() => addPedal(spec.id)}>添加</button>
                </article>
              ))}</div>
            </>
          ) : (
            <div className="preset-browser">
              <div className="library-title"><div><span className="eyebrow">音色库</span><h1>盯鞋起点</h1></div><b>{FACTORY_PRESETS.length + userPresets.length}</b></div>
              <div className="preset-editor">
                <label><span>音色名称</span><input value={presetName} maxLength={28} onChange={(event) => setPresetName(event.target.value)} /></label>
                <button type="button" className="accent" onClick={saveCurrentPreset}>保存当前链</button>
              </div>
              <section className="preset-section">
                <h2>内置音色</h2>
                <div className="preset-list">{FACTORY_PRESETS.map((preset) => (
                  <article className="preset-card" key={preset.id}>
                    <div><strong>{preset.name}</strong><small>{preset.description}</small><span>{preset.chain.length} 块 · {sourceNames[preset.source]}</span></div>
                    <button type="button" onClick={() => loadFactoryPreset(preset.id)}>载入</button>
                  </article>
                ))}</div>
              </section>
              <section className="preset-section">
                <h2>我的音色</h2>
                {userPresets.length === 0 ? <p className="preset-empty">还没有保存在本机的音色。</p> : (
                  <div className="preset-list">{userPresets.map((preset) => (
                    <article className="preset-card user" key={preset.id}>
                      <div><strong>{preset.name}</strong><small>{preset.chain.map((item) => getEffectSpec(item.specId).name).join(' → ')}</small><span>{preset.chain.length} 块 · {sourceNames[preset.source]}</span></div>
                      <button type="button" onClick={() => loadUserPreset(preset)}>载入</button>
                      <button type="button" className="delete-preset" aria-label={'删除' + preset.name} onClick={() => deleteUserPreset(preset)}>删除</button>
                    </article>
                  ))}</div>
                )}
              </section>
            </div>
          )}
        </aside>

        <section id="pedalboard" className="board-stage" aria-label="效果器板画布" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleDrop(event.dataTransfer.getData('text/plain')); }}>
          <div className="board-toolbar">
            <div className="selected-meta">
              <span className="eyebrow">已选效果器</span>
              <div><strong>{selectedSpec?.name ?? '未选择'}</strong><small>{selectedSpec ? categoryNames[selectedSpec.category] + ' · ' + selectedSpec.family + ' · ' + (bypassed.has(selected) ? '已旁通' : '已启用') : ''}</small></div>
            </div>
            <div className="move-actions"><button type="button" disabled={selectedIndex <= 0} onClick={() => moveSelected(-1)}>前移</button><button type="button" disabled={selectedIndex < 0 || selectedIndex >= chain.length - 1} onClick={() => moveSelected(1)}>后移</button><button type="button" disabled={selectedIndex < 0} onClick={removeSelected}>移除</button></div>
            <div className="zoom"><button type="button" aria-label="缩小板面" onClick={() => setZoom((value) => Math.max(.7, value - .08))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="放大板面" onClick={() => setZoom((value) => Math.min(1.1, value + .08))}>+</button></div>
          </div>
          <div className="board-scroll"><div className="board-frame"><div className="chain" style={{ '--scale': zoom } as CSSProperties}>
            <div className="input-box">输入</div><Cable />
            {chain.map((item, index) => (
              <span className="chain-part" key={item.instanceId}>
                <DemoPedal
                  item={item}
                  index={index}
                  values={values[item.instanceId] ?? {}}
                  selected={selected === item.instanceId}
                  bypassed={bypassed.has(item.instanceId)}
                  onSelect={() => setSelected(item.instanceId)}
                  onValue={(id, value) => updateValue(item.instanceId, id, value)}
                  onBypass={() => toggleBypass(item.instanceId)}
                  onDrop={(payload) => handleDrop(payload, item.instanceId)}
                />
                <Cable />
              </span>
            ))}
            <div className="amp"><div><span>固定输出</span><strong>BRIT 20</strong><small>箱头 + 2×12 箱体</small></div><i /></div>
          </div>{chain.length === 0 && <p className="empty">从左侧添加效果器，或载入一个音色。</p>}</div></div>
        </section>
      </div>

      <footer className="transport">
        <label className="source"><span className="eyebrow">固定音源</span><select value={source} aria-label="试听音源" onChange={(event) => { setSource(event.target.value as SourceKind); setRender('idle'); }}><option value="chords">清音和弦循环</option><option value="arpeggio">清音分解和弦</option><option value="lead">清音单音旋律</option></select></label>
        <button className={'play' + (playing ? ' active' : '')} type="button" aria-label={playing ? '停止试听' : '开始试听'} onClick={() => void togglePlayback()}>{playing ? '■' : '▶'}</button>
        <div className="waveform" aria-label={'试听进度 ' + Math.round(progress) + '%'}><i style={{ width: String(progress) + '%' }} />{wave.map((height, index) => <b key={String(height) + '-' + String(index)} style={{ height: String(height) + '%' }} />)}</div>
        <div className="segments" aria-label="干声或效果声">{(['dry', 'wet'] as const).map((entry) => <button key={entry} type="button" className={mode === entry ? 'active' : ''} aria-pressed={mode === entry} onClick={() => { setMode(entry); setRender('idle'); }}>{entry === 'dry' ? '干声' : '效果'}</button>)}</div>
        <div className="segments ab" aria-label="A 或 B 参数">{(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => { setSnapshot(entry); setRender('idle'); }}>{entry}</button>)}</div>
        <label className="output"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => { setOutput(Number(event.target.value)); setRender('idle'); }} /></label>
        <button type="button" className="render" disabled={render === 'busy'} onClick={() => void exportWav()}>{render === 'busy' ? '正在导出…' : render === 'ready' ? '已下载' : '导出 WAV'}</button>
        {audioError && <span className="audio-error" role="alert">{audioError}</span>}
        <span className="sr-only" role="status" aria-live="polite">{render === 'ready' ? 'WAV 音频已下载' : saveState === 'saved' ? '音色已保存在当前浏览器' : ''}</span>
      </footer>
    </main>
  );
}
