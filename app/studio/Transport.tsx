'use client';

import { useEffect, useRef, useState } from 'react';

import type { BoardAudioConfig, LiveAudioSession } from '../audio/audio-engine.ts';
import type { LiveSessionController } from '../audio/live-session-controller.ts';
import {
  CHORD_PROGRESSIONS,
  GUITAR_VOICES,
  PERFORMANCE_SPECS,
  formatSourceConfig,
  getChordProgression,
  type SourceConfig,
} from '../audio/source-catalog.ts';
import type { MonitorMode, SnapshotId } from './board-store.ts';

const wave = [18, 42, 72, 34, 85, 52, 66, 28, 90, 46, 74, 38, 82, 56, 26, 68, 88, 44, 72, 32, 62, 94, 48, 76, 36, 84, 54, 24, 70, 91, 42, 68, 34, 80, 52, 74, 30, 63, 87, 46];

export function getPlaybackProgress(session: LiveAudioSession | null) {
  if (!session || session.context.state === 'closed' || !Number.isFinite(session.duration) || session.duration <= 0 || !Number.isFinite(session.startedAt)) return null;
  const currentTime = session.context.currentTime;
  if (!Number.isFinite(currentTime)) return null;
  const elapsed = currentTime - session.startedAt;
  if (!Number.isFinite(elapsed)) return null;
  const offset = ((elapsed % session.duration) + session.duration) % session.duration;
  return (offset / session.duration) * 100;
}

type Playback = LiveSessionController<BoardAudioConfig, LiveAudioSession>;

/**
 * Transport progress, animated from the audio clock with requestAnimationFrame
 * and written straight to the DOM so playback does not re-render the page.
 */
export function PlaybackWaveform({ playback, playing, loading }: { playback: Playback; playing: boolean; loading: boolean }) {
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

/** Input: the built-in DI recordings, or a live instrument through the audio interface. */
export function SourcePickerDialog({ open, source, liveInputActive, liveInputBusy, onChange, onLiveInput, onClose }: {
  open: boolean;
  source: SourceConfig;
  liveInputActive: boolean;
  liveInputBusy: boolean;
  onChange: (source: SourceConfig) => void;
  onLiveInput: () => void;
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
        <header><div><span>输入</span><h2 id="source-picker-title">选择吉他输入</h2></div><button type="button" onClick={onClose}>完成</button></header>
        <section>
          <h3>输入来源</h3>
          <div className="source-choice-grid" role="radiogroup" aria-label="输入来源">
            <button type="button" role="radio" aria-checked={!liveInputActive} className={!liveInputActive ? 'active' : ''} disabled={liveInputBusy} onClick={() => { if (liveInputActive) onLiveInput(); }}>
              <strong>内置 DI 录音</strong><small>真实电吉他直录，循环播放下面选的和弦与演奏方式。</small>
            </button>
            <button type="button" role="radio" aria-checked={liveInputActive} className={'live-input' + (liveInputActive ? ' active' : '')} disabled={liveInputBusy} title="用声卡或麦克风输入真实吉他（请戴耳机，避免啸叫）" onClick={() => { if (!liveInputActive) onLiveInput(); }}>
              <strong>{liveInputActive ? '● 实时输入' : '实时输入'}</strong><small>通过声卡或麦克风弹你自己的琴。请戴耳机，避免啸叫。</small>
            </button>
          </div>
        </section>
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

/** Press and hold to hear the dry guitar; releasing returns to the board. */
function HoldDryButton({ held, onHold }: { held: boolean; onHold: (held: boolean) => void }) {
  return (
    <button
      type="button"
      className={'hold-dry' + (held ? ' is-held' : '')}
      aria-pressed={held}
      title="按住听干声（或按住 D 键）"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onHold(true);
      }}
      onPointerUp={() => onHold(false)}
      onPointerCancel={() => onHold(false)}
      onLostPointerCapture={() => onHold(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.repeat) return;
        event.preventDefault();
        onHold(true);
      }}
      onKeyUp={(event) => { if (event.key === 'Enter') onHold(false); }}
      onBlur={() => { if (held) onHold(false); }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <i aria-hidden="true" />按住听干声
    </button>
  );
}

function MoreMenu({ render, output, onExport, onOutput }: {
  render: 'idle' | 'busy' | 'ready';
  output: number;
  onExport: () => void;
  onOutput: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="more-menu" ref={root}>
      <button ref={trigger} type="button" className="more-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="更多" onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">⋯</span>{render === 'busy' && <i className="busy-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="more-popover" role="menu" aria-label="更多操作">
          <button type="button" role="menuitem" className="render" disabled={render === 'busy'} onClick={() => { onExport(); setOpen(false); trigger.current?.focus(); }}>
            {render === 'busy' ? '正在导出…' : render === 'ready' ? '已下载，再导出一次' : '导出 WAV'}
          </button>
          <label className="output menu-output" role="none"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => onOutput(Number(event.target.value))} /></label>
        </div>
      )}
    </div>
  );
}

export function Transport({
  playback, playing, playbackLoading, source, liveInputActive, mode, dryHeld, snapshot, output, render, audioError, statusText,
  onTogglePlayback, onOpenInput, onHoldDry, onSnapshot, onCopySnapshot, onOutput, onExport,
}: {
  playback: Playback;
  playing: boolean;
  playbackLoading: boolean;
  source: SourceConfig;
  liveInputActive: boolean;
  mode: MonitorMode;
  dryHeld: boolean;
  snapshot: SnapshotId;
  output: number;
  render: 'idle' | 'busy' | 'ready';
  audioError: string;
  statusText: string;
  onTogglePlayback: () => void;
  onOpenInput: () => void;
  onHoldDry: (held: boolean) => void;
  onSnapshot: (snapshot: SnapshotId) => void;
  onCopySnapshot: () => void;
  onOutput: (value: number) => void;
  onExport: () => void;
}) {
  const other = snapshot === 'A' ? 'B' : 'A';
  return (
    <footer className="transport">
      <button className={'play' + (playing ? ' active' : '') + (playbackLoading ? ' is-loading' : '')} type="button" aria-label={playbackLoading ? '正在加载试听' : playing ? '停止试听' : '开始试听'} title="播放 / 停止（Space）" aria-busy={playbackLoading} disabled={playbackLoading} onClick={onTogglePlayback}>{playbackLoading ? '…' : playing ? '■' : '▶'}</button>
      <button className={'source-trigger' + (liveInputActive ? ' is-live' : '')} type="button" aria-label="选择清音输入" onClick={onOpenInput}>
        <span>{liveInputActive ? '实时输入' : '输入'}</span>
        <strong>{liveInputActive ? '● 声卡 / 麦克风' : formatSourceConfig(source)}</strong>
        {!liveInputActive && <small>{getChordProgression(source.progression).name}</small>}
      </button>
      <PlaybackWaveform playback={playback} playing={playing} loading={playbackLoading} />
      <HoldDryButton held={dryHeld || mode === 'dry'} onHold={onHoldDry} />
      <div className="segments ab" role="group" aria-label="参数快照 A 或 B">
        {(['A', 'B'] as const).map((entry) => <button key={entry} type="button" className={snapshot === entry ? 'active' : ''} aria-pressed={snapshot === entry} onClick={() => onSnapshot(entry)}>快照 {entry}</button>)}
        <button type="button" className="ab-copy" title={'用快照 ' + snapshot + ' 覆盖快照 ' + other} aria-label={'把快照 ' + snapshot + ' 复制到 ' + other} onClick={onCopySnapshot}>{snapshot}→{other}</button>
      </div>
      <label className="output"><span>输出音量</span><input type="range" min="0" max="100" value={output} aria-label="输出音量" onChange={(event) => onOutput(Number(event.target.value))} /></label>
      <MoreMenu render={render} output={output} onExport={onExport} onOutput={onOutput} />
      {audioError && <span className="audio-error" role="alert">{audioError}</span>}
      <span className="sr-only" role="status" aria-live="polite">{statusText}</span>
    </footer>
  );
}
