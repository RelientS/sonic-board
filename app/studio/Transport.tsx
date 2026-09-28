'use client';

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { currentSourcePosition, readInputPeakDbfs, type BoardAudioConfig, type LiveAudioSession } from '../audio/audio-engine.ts';
import type { LiveSessionController } from '../audio/live-session-controller.ts';
import { dragLoop, effectiveLoop, formatSeconds, type LoopRegion } from '../audio/source-catalog.ts';
import { peakScale, type WaveformPeaks } from '../audio/waveform.ts';
import type { MonitorMode, SnapshotId } from './board-store.ts';

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
type LoopPart = 'start' | 'end' | 'region';

const NUDGE_SECONDS = 0.1;

/** Keeps a canvas's backing store at its CSS size times the pixel ratio. */
function useCanvasSize(canvas: RefObject<HTMLCanvasElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => (current.width === width && current.height === height && current.ratio === ratio ? current : { width, height, ratio }));
    };
    // The observer reports the initial size too.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  return size;
}

function drawPeaks(canvas: HTMLCanvasElement, size: { width: number; height: number; ratio: number }, peaks: WaveformPeaks, loop: LoopRegion) {
  const context = canvas.getContext('2d');
  if (!context || size.width === 0) return;
  canvas.width = Math.round(size.width * size.ratio);
  canvas.height = Math.round(size.height * size.ratio);
  context.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  const scale = peakScale(peaks);
  const middle = size.height / 2;
  const columns = peaks.max.length;
  const step = size.width / columns;
  const barWidth = Math.max(1, step - 1);
  for (let i = 0; i < columns; i += 1) {
    const time = ((i + 0.5) / columns) * peaks.duration;
    const inside = time >= loop.start && time < loop.end;
    context.fillStyle = inside ? 'rgba(236, 229, 216, 0.72)' : 'rgba(236, 229, 216, 0.24)';
    const top = middle - Math.max(0.5, peaks.max[i] * scale * middle * 0.92);
    const bottom = middle - Math.min(-0.5, peaks.min[i] * scale * middle * 0.92);
    context.fillRect(i * step, top, barWidth, Math.max(1, bottom - top));
  }
}

/**
 * The current source's real waveform with the playhead and the loop region.
 * Drag the region or its edges (or drag across empty waveform to draw a new
 * one); double-click for the whole source. The handles are sliders: ←/→
 * nudge 0.1 s, Shift for 1 s. While the live input plays, a scrolling input
 * level trace replaces the waveform. Per-frame updates go straight to the DOM.
 */
export function SourceWaveform({ playback, playing, loading, liveInputActive, peaks, loop, sourceName, onLoop }: {
  playback: Playback;
  playing: boolean;
  loading: boolean;
  liveInputActive: boolean;
  peaks: WaveformPeaks | null;
  loop: LoopRegion | null;
  sourceName: string;
  onLoop: (loop: LoopRegion | null) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const playhead = useRef<HTMLElement | null>(null);
  const progress = useRef<HTMLSpanElement | null>(null);
  const size = useCanvasSize(canvas);
  const duration = peaks?.duration ?? 0;
  const region = effectiveLoop(loop, duration);
  const drag = useRef<{ pointerId: number; x: number; part: LoopPart; start: LoopRegion } | null>(null);

  useEffect(() => {
    if (!canvas.current || !peaks || liveInputActive) return;
    drawPeaks(canvas.current, size, peaks, effectiveLoop(loop, peaks.duration));
  }, [size, peaks, loop, liveInputActive]);

  // Playhead and the (visually hidden) progress value, from the audio clock.
  useEffect(() => {
    let shown = -1;
    const write = (fraction: number | null) => {
      if (playhead.current) {
        playhead.current.style.opacity = fraction === null ? '0' : '1';
        if (fraction !== null) playhead.current.style.left = `${fraction * 100}%`;
      }
      const percent = fraction === null ? 0 : Math.round(fraction * 100);
      if (percent === shown || !progress.current) return;
      shown = percent;
      progress.current.setAttribute('aria-valuenow', String(percent));
      progress.current.setAttribute('aria-valuetext', '试听进度 ' + String(percent) + '%');
    };
    write(null);
    if (!playing || liveInputActive) return;
    let frame = 0;
    const tick = () => {
      const session = playback.current;
      const position = currentSourcePosition(session);
      const total = session?.bufferDuration ?? duration;
      write(position === null || !(total > 0) ? null : position / total);
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [playback, playing, liveInputActive, duration]);

  // Live input: a scrolling trace of the input level.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !liveInputActive || size.width === 0) return;
    const context = element.getContext('2d');
    if (!context) return;
    element.width = Math.round(size.width * size.ratio);
    element.height = Math.round(size.height * size.ratio);
    context.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    const history = new Float32Array(Math.max(1, Math.floor(size.width / 3)));
    let frame = 0;
    const tick = () => {
      history.copyWithin(0, 1);
      const level = readInputPeakDbfs(playback.current);
      history[history.length - 1] = Number.isFinite(level) ? Math.max(0, Math.min(1, (level + 60) / 60)) : 0;
      context.clearRect(0, 0, size.width, size.height);
      context.fillStyle = 'rgba(245, 165, 36, 0.7)';
      const middle = size.height / 2;
      for (let i = 0; i < history.length; i += 1) {
        const half = Math.max(0.5, history[i] * middle * 0.92);
        context.fillRect(i * 3, middle - half, 2, half * 2);
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [liveInputActive, playback, size]);

  const secondsAt = (clientX: number) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };
  const beginDrag = (event: ReactPointerEvent<HTMLElement>, part: LoopPart, start: LoopRegion) => {
    if (event.button !== 0 || !peaks || liveInputActive) return;
    event.preventDefault();
    event.stopPropagation();
    host.current?.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, part, start };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const rect = host.current?.getBoundingClientRect();
    if (!state || state.pointerId !== event.pointerId || !rect || rect.width === 0) return;
    const delta = ((event.clientX - state.x) / rect.width) * duration;
    onLoop(dragLoop(state.start, state.part, delta, duration));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const onHandleKey = (event: ReactKeyboardEvent<HTMLElement>, part: 'start' | 'end') => {
    const step = event.shiftKey ? 1 : NUDGE_SECONDS;
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    // The studio's ←/→ shortcuts walk the board; here they move the handle.
    event.stopPropagation();
    onLoop(dragLoop(region, part, delta, duration));
  };

  const left = duration > 0 ? (region.start / duration) * 100 : 0;
  const width = duration > 0 ? ((region.end - region.start) / duration) * 100 : 100;
  const whole = !loop || (region.start <= 0 && region.end >= duration);

  return (
    <div
      ref={host}
      className={'waveform' + (loading ? ' is-loading' : '') + (liveInputActive ? ' is-live' : '')}
      role="group"
      aria-label={liveInputActive ? '实时输入电平' : `音源波形：${sourceName}`}
      onPointerDown={(event) => {
        // Drag across the waveform to draw a new loop from that point.
        const at = secondsAt(event.clientX);
        beginDrag(event, 'end', { start: at, end: at });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => { if (!liveInputActive) onLoop(null); }}
    >
      <canvas ref={canvas} aria-hidden="true" />
      {!liveInputActive && peaks && (
        <div
          className={'loop-region' + (whole ? ' is-whole' : '')}
          style={{ left: `${left}%`, width: `${width}%` }}
          // Over the whole source there is nothing to move: let the waveform draw a new loop.
          onPointerDown={(event) => { if (!whole) beginDrag(event, 'region', region); }}
        >
          <span
            className="loop-handle is-start"
            role="slider"
            tabIndex={0}
            aria-label="循环起点"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration * 10) / 10}
            aria-valuenow={Math.round(region.start * 10) / 10}
            aria-valuetext={formatSeconds(region.start)}
            onPointerDown={(event) => beginDrag(event, 'start', region)}
            onKeyDown={(event) => onHandleKey(event, 'start')}
          />
          <span
            className="loop-handle is-end"
            role="slider"
            tabIndex={0}
            aria-label="循环终点"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration * 10) / 10}
            aria-valuenow={Math.round(region.end * 10) / 10}
            aria-valuetext={formatSeconds(region.end)}
            onPointerDown={(event) => beginDrag(event, 'end', region)}
            onKeyDown={(event) => onHandleKey(event, 'end')}
          />
        </div>
      )}
      <i ref={playhead} className="playhead" aria-hidden="true" />
      <span ref={progress} className="sr-only" role="progressbar" aria-label="试听进度" aria-valuemin={0} aria-valuemax={100} aria-busy={loading} />
      {!liveInputActive && peaks && !whole && (
        <span className="loop-readout" aria-hidden="true">{formatSeconds(region.start)}–{formatSeconds(region.end)}</span>
      )}
      {!liveInputActive && !whole && (
        <button type="button" className="loop-reset" onPointerDown={(event) => event.stopPropagation()} onClick={() => onLoop(null)}>整段</button>
      )}
      {loading && <span className="waveform-status">正在加载试听…</span>}
    </div>
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
  playback, playing, playbackLoading, sourceName, liveInputActive, peaks, loop, mode, dryHeld, snapshot, output, render, audioError, statusText,
  onTogglePlayback, onOpenInput, onLoop, onHoldDry, onSnapshot, onCopySnapshot, onOutput, onExport,
}: {
  playback: Playback;
  playing: boolean;
  playbackLoading: boolean;
  /** What is feeding the board: an example phrase, a take, or the live input. */
  sourceName: string;
  liveInputActive: boolean;
  peaks: WaveformPeaks | null;
  loop: LoopRegion | null;
  mode: MonitorMode;
  dryHeld: boolean;
  snapshot: SnapshotId;
  output: number;
  render: 'idle' | 'busy' | 'ready';
  audioError: string;
  statusText: string;
  onTogglePlayback: () => void;
  onOpenInput: () => void;
  onLoop: (loop: LoopRegion | null) => void;
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
      <button className={'source-trigger' + (liveInputActive ? ' is-live' : '')} type="button" aria-label={`输入：${sourceName}。打开输入面板`} onClick={onOpenInput}>
        <span>{liveInputActive ? '实时输入' : '输入'}</span>
        <strong>{sourceName}</strong>
      </button>
      <SourceWaveform playback={playback} playing={playing} loading={playbackLoading} liveInputActive={liveInputActive} peaks={peaks} loop={loop} sourceName={sourceName} onLoop={onLoop} />
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
