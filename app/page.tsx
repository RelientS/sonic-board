'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

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
    id: 'wall-fuzz', name: 'WALL FUZZ', maker: 'SOLID STATE WORKS', kind: 'Fuzz',
    finish: '#d5d0c1', ink: '#20201e', accent: '#ed4f34', wide: true,
    knobs: [{ id: 'volume', label: 'VOLUME', value: 58 }, { id: 'tone', label: 'TONE', value: 43 }, { id: 'sustain', label: 'SUSTAIN', value: 67 }],
  },
  {
    id: 'slow-phase', name: 'SLOW PHASE', maker: 'ORBITAL AUDIO', kind: 'Mod',
    finish: '#d57b29', ink: '#21150f', accent: '#542417',
    knobs: [{ id: 'rate', label: 'RATE', value: 22 }, { id: 'depth', label: 'DEPTH', value: 38 }, { id: 'res', label: 'RES', value: 18 }],
  },
  {
    id: 'reverse-space', name: 'REVERSE SPACE', maker: 'NOCTURNE DEVICES', kind: 'Space',
    finish: '#293c51', ink: '#f3efe4', accent: '#8be0d5',
    knobs: [{ id: 'mix', label: 'MIX', value: 42 }, { id: 'decay', label: 'DECAY', value: 64 }, { id: 'tone', label: 'TONE', value: 46 }],
  },
  {
    id: 'soft-detune', name: 'SOFT DETUNE', maker: 'PARALLEL LAB', kind: 'Mod',
    finish: '#cbded5', ink: '#173931', accent: '#ef6352',
    knobs: [{ id: 'cents', label: 'CENTS', value: 35 }, { id: 'blend', label: 'BLEND', value: 28 }, { id: 'spread', label: 'SPREAD', value: 54 }],
  },
  {
    id: 'tape-echo', name: 'TAPE ECHO', maker: 'FIELD UNIT', kind: 'Delay',
    finish: '#613126', ink: '#f2d4aa', accent: '#efb149',
    knobs: [{ id: 'time', label: 'TIME', value: 48 }, { id: 'repeats', label: 'REPEATS', value: 34 }, { id: 'mix', label: 'MIX', value: 27 }],
  },
  {
    id: 'cloud-hall', name: 'CLOUD HALL', maker: 'NORTH COAST AUDIO', kind: 'Space',
    finish: '#9688b8', ink: '#181323', accent: '#f3d778',
    knobs: [{ id: 'decay', label: 'DECAY', value: 72 }, { id: 'motion', label: 'MOTION', value: 31 }, { id: 'mix', label: 'MIX', value: 38 }],
  },
];

const firstChain: ChainItem[] = [
  { instanceId: 'wall-fuzz-1', specId: 'wall-fuzz' },
  { instanceId: 'slow-phase-1', specId: 'slow-phase' },
  { instanceId: 'reverse-space-1', specId: 'reverse-space' },
];

const wave = [18, 42, 72, 34, 85, 52, 66, 28, 90, 46, 74, 38, 82, 56, 26, 68, 88, 44, 72, 32, 62, 94, 48, 76, 36, 84, 54, 24, 70, 91, 42, 68, 34, 80, 52, 74, 30, 63, 87, 46];

function makeValues(chain: ChainItem[]) {
  return chain.reduce<Values>((all, item) => {
    const spec = specs.find((entry) => entry.id === item.specId)!;
    all[item.instanceId] = Object.fromEntries(spec.knobs.map((knob) => [knob.id, knob.value]));
    return all;
  }, {});
}

function KnobControl({ knob, value, disabled, onChange }: { knob: Knob; value: number; disabled: boolean; onChange: (value: number) => void }) {
  const style = { '--angle': `${-138 + value * 2.76}deg` } as CSSProperties;
  return (
    <label className="knob-control">
      <span className="knob-label">{knob.label}</span>
      <span className="knob-hit">
        <span className="knob" style={style} aria-hidden="true"><span /></span>
        <input type="range" min="0" max="100" value={value} disabled={disabled} aria-label={`${knob.label}, ${value}`} onChange={(event) => onChange(Number(event.target.value))} />
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
      aria-label={`${index + 1}. ${spec.name}${bypassed ? ', bypassed' : ''}`}
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
        <button className="footswitch" type="button" aria-label={`${bypassed ? 'Enable' : 'Bypass'} ${spec.name}`} aria-pressed={!bypassed} onClick={(event) => { event.stopPropagation(); onBypass(); }}>
          <span className={`led${bypassed ? '' : ' on'}`} aria-hidden="true" />
          <span className="metal-switch" aria-hidden="true" />
          <small>{bypassed ? 'BYPASS' : 'ACTIVE'}</small>
        </button>
      </div>
    </article>
  );
}

function soundPreview(dry: boolean) {
  const Audio = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Audio) return null;
  const context = new Audio();
  const bus = context.createGain();
  let output: AudioNode = bus;
  if (!dry) {
    const shaper = context.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i += 1) curve[i] = Math.tanh(((i * 2) / curve.length - 1) * 10);
    shaper.curve = curve;
    shaper.oversample = '4x';
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    const wet = context.createGain();
    const sum = context.createGain();
    delay.delayTime.value = 0.38;
    feedback.gain.value = 0.28;
    wet.gain.value = 0.32;
    bus.connect(shaper);
    shaper.connect(sum);
    shaper.connect(delay).connect(feedback).connect(delay);
    delay.connect(wet).connect(sum);
    output = sum;
  }
  const master = context.createGain();
  master.gain.value = dry ? 0.1 : 0.07;
  output.connect(master).connect(context.destination);
  const start = context.currentTime + 0.04;
  [[110, 164.8, 220], [98, 146.8, 196], [82.4, 123.5, 164.8], [92.5, 138.6, 185]].forEach((chord, step) => {
    chord.forEach((frequency, note) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      const filter = context.createBiquadFilter();
      osc.type = note ? 'sawtooth' : 'triangle';
      osc.frequency.value = frequency;
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3800, start + step * 1.45);
      filter.frequency.exponentialRampToValueAtTime(620, start + step * 1.45 + 1.28);
      gain.gain.setValueAtTime(0.0001, start + step * 1.45);
      gain.gain.exponentialRampToValueAtTime(0.16, start + step * 1.45 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + step * 1.45 + 1.36);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(start + step * 1.45);
      osc.stop(start + step * 1.45 + 1.4);
    });
  });
  return context;
}

export default function Home() {
  const [chain, setChain] = useState(firstChain);
  const [snapshots, setSnapshots] = useState<Record<'A' | 'B', Values>>(() => ({ A: makeValues(firstChain), B: makeValues(firstChain) }));
  const [snapshot, setSnapshot] = useState<'A' | 'B'>('A');
  const [selected, setSelected] = useState(firstChain[0].instanceId);
  const [bypassed, setBypassed] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<'All' | Kind>('All');
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<'Dry' | 'Wet'>('Wet');
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [render, setRender] = useState<'idle' | 'busy' | 'ready'>('idle');
  const audio = useRef<AudioContext | null>(null);
  const values = snapshots[snapshot];
  const selectedIndex = chain.findIndex((item) => item.instanceId === selected);
  const selectedSpec = specs.find((spec) => spec.id === chain[selectedIndex]?.specId);

  const library = useMemo(() => specs.filter((spec) => (kind === 'All' || spec.kind === kind) && `${spec.name} ${spec.maker}`.toLowerCase().includes(search.toLowerCase())), [kind, search]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setProgress((value) => {
      if (value >= 100) { setPlaying(false); return 0; }
      return value + 1.35;
    }), 80);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => () => { void audio.current?.close(); }, []);

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
  }

  async function togglePlayback() {
    if (playing) {
      setPlaying(false); setProgress(0); await audio.current?.close(); audio.current = null; return;
    }
    await audio.current?.close();
    audio.current = soundPreview(mode === 'Dry');
    setProgress(0); setPlaying(true);
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#pedalboard">Skip to pedalboard</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /></span><div><strong>SONIC BOARD</strong><small>Cloud Wall</small></div></div>
        <div className="signal-note"><i /> Signal follows cable order</div>
        <div className="top-actions"><span>DEMO</span><button type="button" className="quiet" onClick={() => { setChain(firstChain); setSnapshots({ A: makeValues(firstChain), B: makeValues(firstChain) }); setSelected(firstChain[0].instanceId); setBypassed(new Set()); }}>Reset</button><button type="button" className="accent" onClick={() => setRender('ready')}>Save preset</button></div>
      </header>

      <div className="workspace">
        <aside className="library-panel" aria-label="Effect library">
          <div className="library-title"><div><span className="eyebrow">EFFECT LIBRARY</span><h1>Pedals</h1></div><b>{library.length}</b></div>
          <label className="search"><span className="sr-only">Search pedals</span><input placeholder="Search pedals" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="filters" aria-label="Filter pedal types">{(['All', 'Fuzz', 'Mod', 'Delay', 'Space'] as const).map((entry) => <button key={entry} type="button" className={kind === entry ? 'active' : ''} aria-pressed={kind === entry} onClick={() => setKind(entry)}>{entry}</button>)}</div>
          <div className="library-list">{library.map((spec) => (
            <article key={spec.id} className="library-item" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', `add:${spec.id}`)}>
              <MiniPedal spec={spec} /><div><span>{spec.kind}</span><strong>{spec.name}</strong><small>{spec.maker}</small></div><button type="button" aria-label={`Add ${spec.name}`} onClick={() => addPedal(spec.id)}>Add</button>
            </article>
          ))}</div>
        </aside>

        <section id="pedalboard" className="board-stage" aria-label="Pedalboard canvas" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleDrop(event.dataTransfer.getData('text/plain')); }}>
          <div className="board-toolbar">
            <div className="selected-meta"><span className="eyebrow">SELECTED</span><strong>{selectedSpec?.name ?? 'No pedal selected'}</strong><small>{selectedSpec ? `${selectedSpec.kind} · ${bypassed.has(selected) ? 'Bypassed' : 'Active'}` : ''}</small></div>
            <div className="move-actions"><button type="button" disabled={selectedIndex <= 0} onClick={() => moveSelected(-1)}>Move left</button><button type="button" disabled={selectedIndex < 0 || selectedIndex >= chain.length - 1} onClick={() => moveSelected(1)}>Move right</button><button type="button" disabled={selectedIndex < 0} onClick={removeSelected}>Remove</button></div>
            <div className="zoom"><button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(.78, value - .08))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.18, value + .08))}>+</button></div>
          </div>
          <div className="board-scroll"><div className="board-frame"><div className="chain" style={{ '--scale': zoom } as CSSProperties}>
            <div className="input-box">IN</div><Cable />
            {chain.map((item, index) => <span className="chain-part" key={item.instanceId}><DemoPedal item={item} index={index} values={values[item.instanceId] ?? {}} selected={selected === item.instanceId} bypassed={bypassed.has(item.instanceId)} onSelect={() => setSelected(item.instanceId)} onValue={(id, value) => updateValue(item.instanceId, id, value)} onBypass={() => setBypassed((current) => { const next = new Set(current); next.has(item.instanceId) ? next.delete(item.instanceId) : next.add(item.instanceId); return next; })} onDrop={(payload) => handleDrop(payload, item.instanceId)} /><Cable /></span>)}
            <div className="amp"><div><span>FIXED OUTPUT</span><strong>BRIT 20</strong><small>AMP + 2×12 CAB</small></div><i /></div>
          </div>{chain.length === 0 && <p className="empty">Drag a pedal here or use Add.</p>}</div></div>
        </section>
      </div>

      <footer className="transport">
        <label className="source"><span className="eyebrow">SOURCE</span><select defaultValue="chords" aria-label="Demo audio source"><option value="chords">Clean chord loop</option><option value="arpeggio">Clean arpeggio</option><option value="lead">Single-note lead</option></select></label>
        <button className={`play${playing ? ' active' : ''}`} type="button" aria-label={playing ? 'Stop preview' : 'Play preview'} onClick={() => void togglePlayback()}>{playing ? '■' : '▶'}</button>
        <div className="waveform" aria-label={`Preview progress ${Math.round(progress)} percent`}><i style={{ width: `${progress}%` }} />{wave.map((height, index) => <b key={`${height}-${index}`} style={{ height: `${height}%` }} />)}</div>
        <div className="segments" aria-label="Dry or processed preview">{(['Dry', 'Wet'] as const).map((entry) => <button key={entry} type="button" className={mode === entry ? 'active' : ''} aria-pressed={mode === entry} onClick={() => setMode(entry)}>{entry}</button>)}</div>
        <div className="segments ab" aria-label="A or B settings">{(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => setSnapshot(entry)}>{entry}</button>)}</div>
        <label className="output"><span>OUTPUT</span><input type="range" min="0" max="100" defaultValue="72" aria-label="Output volume" /></label>
        <button type="button" className="render" disabled={render === 'busy'} onClick={() => { setRender('busy'); window.setTimeout(() => setRender('ready'), 1200); }}>{render === 'busy' ? 'Rendering…' : render === 'ready' ? 'Preview ready' : 'Render'}</button>
        <span className="sr-only" role="status" aria-live="polite">{render === 'ready' ? 'Preview render complete' : ''}</span>
      </footer>
    </main>
  );
}
