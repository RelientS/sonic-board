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

type Kind = 'Fuzz' | 'Mod' | 'Delay' | 'Space';
type Knob = { id: string; label: string; value: number };
type PedalSpec = {
  id: string;
  name: string;
  maker: string;
  kind: Kind;
  finish: string;
  ink: string;
  accent: string;
  wide?: boolean;
  knobs: Knob[];
};
type ChainItem = { instanceId: string; specId: string };
type Values = Record<string, Record<string, number>>;

const specs: PedalSpec[] = [
  {
    id: 'wall-fuzz', name: '音墙法兹', maker: '固态工坊', kind: 'Fuzz',
    finish: '#d5d0c1', ink: '#20201e', accent: '#ed4f34', wide: true,
    knobs: [{ id: 'volume', label: '音量', value: 58 }, { id: 'tone', label: '音色', value: 43 }, { id: 'sustain', label: '延音', value: 67 }],
  },
  {
    id: 'slow-phase', name: '慢速相位', maker: '轨道音频', kind: 'Mod',
    finish: '#d57b29', ink: '#21150f', accent: '#542417',
    knobs: [{ id: 'rate', label: '速率', value: 22 }, { id: 'depth', label: '深度', value: 38 }, { id: 'res', label: '共振', value: 18 }],
  },
  {
    id: 'reverse-space', name: '反向空间', maker: '夜航设备', kind: 'Space',
    finish: '#293c51', ink: '#f3efe4', accent: '#8be0d5',
    knobs: [{ id: 'mix', label: '混合', value: 42 }, { id: 'decay', label: '衰减', value: 64 }, { id: 'tone', label: '音色', value: 46 }],
  },
  {
    id: 'soft-detune', name: '轻微失谐', maker: '并行实验室', kind: 'Mod',
    finish: '#cbded5', ink: '#173931', accent: '#ef6352',
    knobs: [{ id: 'cents', label: '音分', value: 35 }, { id: 'blend', label: '混合', value: 28 }, { id: 'spread', label: '宽度', value: 54 }],
  },
  {
    id: 'tape-echo', name: '磁带回声', maker: '现场单元', kind: 'Delay',
    finish: '#613126', ink: '#f2d4aa', accent: '#efb149',
    knobs: [{ id: 'time', label: '时间', value: 48 }, { id: 'repeats', label: '反馈', value: 34 }, { id: 'mix', label: '混合', value: 27 }],
  },
  {
    id: 'cloud-hall', name: '云端大厅', maker: '北岸音频', kind: 'Space',
    finish: '#9688b8', ink: '#181323', accent: '#f3d778',
    knobs: [{ id: 'decay', label: '衰减', value: 72 }, { id: 'motion', label: '漂移', value: 31 }, { id: 'mix', label: '混合', value: 38 }],
  },
];

const firstChain: ChainItem[] = [
  { instanceId: 'wall-fuzz-1', specId: 'wall-fuzz' },
  { instanceId: 'slow-phase-1', specId: 'slow-phase' },
  { instanceId: 'reverse-space-1', specId: 'reverse-space' },
];
const wave = [18, 42, 72, 34, 85, 52, 66, 28, 90, 46, 74, 38, 82, 56, 26, 68, 88, 44, 72, 32, 62, 94, 48, 76, 36, 84, 54, 24, 70, 91, 42, 68, 34, 80, 52, 74, 30, 63, 87, 46];
const kindNames: Record<'All' | Kind, string> = { All: '全部', Fuzz: '法兹', Mod: '调制', Delay: '延迟', Space: '空间' };

function makeValues(chain: ChainItem[]) {
  return chain.reduce<Values>((all, item) => {
    const spec = specs.find((entry) => entry.id === item.specId)!;
    all[item.instanceId] = Object.fromEntries(spec.knobs.map((knob) => [knob.id, knob.value]));
    return all;
  }, {});
}

function makeInitialSnapshots() {
  const a = makeValues(firstChain);
  const b = makeValues(firstChain);
  b['wall-fuzz-1'].sustain = 84;
  b['slow-phase-1'].rate = 12;
  b['slow-phase-1'].depth = 48;
  b['reverse-space-1'].mix = 54;
  return { A: a, B: b };
}

function KnobControl({ knob, value, disabled, onChange }: { knob: Knob; value: number; disabled: boolean; onChange: (value: number) => void }) {
  const style = { '--angle': `${-138 + value * 2.76}deg` } as CSSProperties;
  return (
    <label className="knob-control">
      <span className="knob-label">{knob.label}</span>
      <span className="knob-hit">
        <span className="knob" style={style} aria-hidden="true"><span /></span>
        <input type="range" min="0" max="100" value={value} disabled={disabled} aria-label={`${knob.label}，${value}`} onChange={(event) => onChange(Number(event.target.value))} />
      </span>
      <span className="knob-readout">{value}</span>
    </label>
  );
}

function Cable() {
  return <span className="cable" aria-hidden="true"><i /><b /><i /></span>;
}

function MiniPedal({ spec }: { spec: PedalSpec }) {
  const style = { '--finish': spec.finish, '--ink': spec.ink } as CSSProperties;
  return <span className={`mini-pedal${spec.wide ? ' is-wide' : ''}`} style={style} aria-hidden="true"><i /><i /><i /><b /></span>;
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
  const spec = specs.find((entry) => entry.id === item.specId)!;
  const style = { '--finish': spec.finish, '--ink': spec.ink, '--accent': spec.accent } as CSSProperties;
  return (
    <article
      className={`pedal-unit${spec.wide ? ' is-wide' : ''}${selected ? ' is-selected' : ''}${bypassed ? ' is-bypassed' : ''}`}
      draggable
      tabIndex={0}
      aria-label={`${index + 1}. ${spec.name}${bypassed ? '，已旁通' : ''}`}
      onClick={onSelect}
      onDragStart={(event) => event.dataTransfer.setData('text/plain', `move:${item.instanceId}`)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/plain')); }}
    >
      <span className="order-badge">{index + 1}</span>
      <div className="pedal-body" style={style}>
        <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
        <span className="jack jack-left" /><span className="jack jack-right" />
        <div className="pedal-maker">{spec.maker}</div>
        <div className="knob-row">
          {spec.knobs.map((knob) => <KnobControl key={knob.id} knob={knob} value={values[knob.id] ?? knob.value} disabled={bypassed} onChange={(value) => onValue(knob.id, value)} />)}
        </div>
        <div className="pedal-lines" aria-hidden="true"><i /><i /><i /></div>
        <h2>{spec.name}</h2>
        <button className="footswitch" type="button" aria-label={`${bypassed ? '启用' : '旁通'}${spec.name}`} aria-pressed={!bypassed} onClick={(event) => { event.stopPropagation(); onBypass(); }}>
          <span className={`led${bypassed ? '' : ' on'}`} aria-hidden="true" />
          <span className="metal-switch" aria-hidden="true" />
          <small>{bypassed ? '已旁通' : '已启用'}</small>
        </button>
      </div>
    </article>
  );
}

export default function Home() {
  const [chain, setChain] = useState(firstChain);
  const [snapshots, setSnapshots] = useState<Record<'A' | 'B', Values>>(makeInitialSnapshots);
  const [snapshot, setSnapshot] = useState<'A' | 'B'>('A');
  const [selected, setSelected] = useState(firstChain[0].instanceId);
  const [bypassed, setBypassed] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<'All' | Kind>('All');
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<'dry' | 'wet'>('wet');
  const [source, setSource] = useState<SourceKind>('chords');
  const [output, setOutput] = useState(72);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [render, setRender] = useState<'idle' | 'busy' | 'ready'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [audioError, setAudioError] = useState('');
  const audio = useRef<LiveAudioSession | null>(null);
  const values = snapshots[snapshot];
  const selectedIndex = chain.findIndex((item) => item.instanceId === selected);
  const selectedSpec = specs.find((spec) => spec.id === chain[selectedIndex]?.specId);

  const library = useMemo(() => specs.filter((spec) => (kind === 'All' || spec.kind === kind) && `${spec.name} ${spec.maker}`.toLowerCase().includes(search.toLowerCase())), [kind, search]);
  const audioConfig = useMemo<BoardAudioConfig>(() => ({
    chain,
    values,
    bypassed: [...bypassed],
    source,
    mode,
    output,
  }), [chain, values, bypassed, source, mode, output]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setProgress((value) => (value + 1.35) % 100), 80);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (!playing || !audio.current) return;
    const timer = window.setTimeout(() => {
      if (audio.current) refreshLiveSession(audio.current, audioConfig);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [audioConfig, playing]);

  useEffect(() => () => { void disposeLiveSession(audio.current); }, []);

  function resetBoard() {
    setChain(firstChain);
    setSnapshots(makeInitialSnapshots());
    setSnapshot('A');
    setSelected(firstChain[0].instanceId);
    setBypassed(new Set());
    setMode('wet');
    setSource('chords');
    setOutput(72);
    setRender('idle');
    setAudioError('');
  }

  function updateValue(instanceId: string, knobId: string, value: number) {
    setSnapshots((current) => ({ ...current, [snapshot]: { ...current[snapshot], [instanceId]: { ...current[snapshot][instanceId], [knobId]: value } } }));
    setRender('idle');
  }

  function addPedal(specId: string) {
    const spec = specs.find((entry) => entry.id === specId)!;
    const instanceId = `${specId}-${Date.now()}`;
    const defaults = Object.fromEntries(spec.knobs.map((knob) => [knob.id, knob.value]));
    setChain((current) => [...current, { instanceId, specId }]);
    setSnapshots((current) => ({ A: { ...current.A, [instanceId]: { ...defaults } }, B: { ...current.B, [instanceId]: { ...defaults } } }));
    setSelected(instanceId);
    setRender('idle');
  }

  function moveItem(instanceId: string, targetId: string) {
    if (instanceId === targetId) return;
    setChain((current) => {
      const from = current.findIndex((item) => item.instanceId === instanceId);
      const to = current.findIndex((item) => item.instanceId === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
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
    setRender('idle');
  }

  function toggleBypass(instanceId: string) {
    setBypassed((current) => {
      const next = new Set(current);
      next.has(instanceId) ? next.delete(instanceId) : next.add(instanceId);
      return next;
    });
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

  function savePreset() {
    try {
      window.localStorage.setItem('sonic-board-preset', JSON.stringify({ chain, snapshots, bypassed: [...bypassed], source, output }));
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1400);
    } catch {
      setAudioError('预设保存失败，请检查浏览器存储权限。');
    }
  }

  async function exportWav() {
    setRender('busy');
    setAudioError('');
    try {
      const blob = await renderBoardToWav(audioConfig);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `Sonic-Board-${source}-${snapshot}.wav`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setRender('ready');
    } catch {
      setRender('idle');
      setAudioError('音频导出失败，请稍后再试。');
    }
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#pedalboard">跳到效果器板</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /></span><div><strong>SONIC BOARD</strong><small>云墙音色板</small></div></div>
        <div className="signal-note"><i /> 信号按连接线顺序流动</div>
        <div className="top-actions"><span>演示版</span><button type="button" className="quiet" onClick={resetBoard}>重置</button><button type="button" className="accent" onClick={savePreset}>{saveState === 'saved' ? '已保存' : '保存预设'}</button></div>
      </header>

      <div className="workspace">
        <aside className="library-panel" aria-label="效果器库">
          <div className="library-title"><div><span className="eyebrow">效果器库</span><h1>单块效果器</h1></div><b>{library.length}</b></div>
          <label className="search"><span className="sr-only">搜索效果器</span><input placeholder="搜索效果器" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="filters" aria-label="筛选效果器类型">{(['All', 'Fuzz', 'Mod', 'Delay', 'Space'] as const).map((entry) => <button key={entry} type="button" className={kind === entry ? 'active' : ''} aria-pressed={kind === entry} onClick={() => setKind(entry)}>{kindNames[entry]}</button>)}</div>
          <div className="library-list">{library.map((spec) => (
            <article key={spec.id} className="library-item" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', `add:${spec.id}`)}>
              <MiniPedal spec={spec} /><div><span>{kindNames[spec.kind]}</span><strong>{spec.name}</strong><small>{spec.maker}</small></div><button type="button" aria-label={`添加${spec.name}`} onClick={() => addPedal(spec.id)}>添加</button>
            </article>
          ))}</div>
        </aside>

        <section id="pedalboard" className="board-stage" aria-label="效果器板画布" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleDrop(event.dataTransfer.getData('text/plain')); }}>
          <div className="board-toolbar">
            <div className="selected-meta"><span className="eyebrow">已选效果器</span><strong>{selectedSpec?.name ?? '未选择'}</strong><small>{selectedSpec ? `${kindNames[selectedSpec.kind]} · ${bypassed.has(selected) ? '已旁通' : '已启用'}` : ''}</small></div>
            <div className="move-actions"><button type="button" disabled={selectedIndex <= 0} onClick={() => moveSelected(-1)}>前移</button><button type="button" disabled={selectedIndex < 0 || selectedIndex >= chain.length - 1} onClick={() => moveSelected(1)}>后移</button><button type="button" disabled={selectedIndex < 0} onClick={removeSelected}>移除</button></div>
            <div className="zoom"><button type="button" aria-label="缩小板面" onClick={() => setZoom((value) => Math.max(.78, value - .08))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="放大板面" onClick={() => setZoom((value) => Math.min(1.18, value + .08))}>+</button></div>
          </div>
          <div className="board-scroll"><div className="board-frame"><div className="chain" style={{ '--scale': zoom } as CSSProperties}>
            <div className="input-box">输入</div><Cable />
            {chain.map((item, index) => <span className="chain-part" key={item.instanceId}><DemoPedal item={item} index={index} values={values[item.instanceId] ?? {}} selected={selected === item.instanceId} bypassed={bypassed.has(item.instanceId)} onSelect={() => setSelected(item.instanceId)} onValue={(id, value) => updateValue(item.instanceId, id, value)} onBypass={() => toggleBypass(item.instanceId)} onDrop={(payload) => handleDrop(payload, item.instanceId)} /><Cable /></span>)}
            <div className="amp"><div><span>固定输出</span><strong>BRIT 20</strong><small>箱头 + 2×12 箱体</small></div><i /></div>
          </div>{chain.length === 0 && <p className="empty">从左侧添加效果器，或拖到这里。</p>}</div></div>
        </section>
      </div>

      <footer className="transport">
        <label className="source"><span className="eyebrow">固定音源</span><select value={source} aria-label="试听音源" onChange={(event) => { setSource(event.target.value as SourceKind); setRender('idle'); }}><option value="chords">清音和弦循环</option><option value="arpeggio">清音分解和弦</option><option value="lead">清音单音旋律</option></select></label>
        <button className={`play${playing ? ' active' : ''}`} type="button" aria-label={playing ? '停止试听' : '开始试听'} onClick={() => void togglePlayback()}>{playing ? '■' : '▶'}</button>
        <div className="waveform" aria-label={`试听进度 ${Math.round(progress)}%`}><i style={{ width: `${progress}%` }} />{wave.map((height, index) => <b key={`${height}-${index}`} style={{ height: `${height}%` }} />)}</div>
        <div className="segments" aria-label="干声或效果声">{(['dry', 'wet'] as const).map((entry) => <button key={entry} type="button" className={mode === entry ? 'active' : ''} aria-pressed={mode === entry} onClick={() => { setMode(entry); setRender('idle'); }}>{entry === 'dry' ? '干声' : '效果'}</button>)}</div>
        <div className="segments ab" aria-label="A 或 B 参数">{(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => { setSnapshot(entry); setRender('idle'); }}>{entry}</button>)}</div>
        <label className="output"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => { setOutput(Number(event.target.value)); setRender('idle'); }} /></label>
        <button type="button" className="render" disabled={render === 'busy'} onClick={() => void exportWav()}>{render === 'busy' ? '正在导出…' : render === 'ready' ? '已下载' : '导出 WAV'}</button>
        {audioError && <span className="audio-error" role="alert">{audioError}</span>}
        <span className="sr-only" role="status" aria-live="polite">{render === 'ready' ? 'WAV 音频已下载' : saveState === 'saved' ? '预设已保存在当前浏览器' : ''}</span>
      </footer>
    </main>
  );
}
