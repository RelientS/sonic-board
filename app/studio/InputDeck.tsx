'use client';

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import {
  CHORD_PROGRESSIONS,
  GUITAR_VOICES,
  INPUT_LEVEL_TARGET,
  INPUT_TRIM_RANGE_DB,
  PERFORMANCE_SPECS,
  clampTrimDb,
  formatSeconds,
  inputLevelVerdict,
  type InputSettings,
  type SourceConfig,
} from '../audio/source-catalog.ts';
import { MAX_RECORDING_SECONDS, MAX_UPLOAD_SECONDS, type TakeMeta } from '../audio/takes-store.ts';
import type { ControlSpec } from '../effects/catalog.ts';
import { KnobControl, type HelpTarget } from './Knob.tsx';

export type InputTab = 'example' | 'takes' | 'live';
export type RecordingState = { seconds: number; peakDbfs: number } | null;

const TRIM_CONTROL: ControlSpec = {
  id: 'trim', label: '输入增益', defaultValue: 50, min: -INPUT_TRIM_RANGE_DB, max: INPUT_TRIM_RANGE_DB, unit: 'dB', decimals: 1, curve: 'linear',
};
const trimToKnob = (db: number) => ((clampTrimDb(db) + INPUT_TRIM_RANGE_DB) / (2 * INPUT_TRIM_RANGE_DB)) * 100;
const knobToTrim = (value: number) => clampTrimDb((value / 100) * 2 * INPUT_TRIM_RANGE_DB - INPUT_TRIM_RANGE_DB);

/** Meter scale: −60…0 dBFS. */
const METER_FLOOR = -60;
const meterPercent = (dbfs: number) => Math.max(0, Math.min(100, ((dbfs - METER_FLOOR) / -METER_FLOOR) * 100));

/**
 * Post-trim input level, read from the audio graph every frame and written to
 * the DOM directly (no React state per frame), with a 1.5 s peak hold and a
 * 偏小 / 合适 / 偏大 verdict for how hard the board is being driven.
 */
export function InputMeter({ read, active }: { read: () => number; active: boolean }) {
  const bar = useRef<HTMLElement | null>(null);
  const hold = useRef<HTMLElement | null>(null);
  const verdict = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const reset = () => {
      if (bar.current) bar.current.style.width = '0%';
      if (hold.current) hold.current.style.left = '0%';
      if (verdict.current) verdict.current.textContent = active ? '没有信号' : '播放时显示电平';
    };
    reset();
    if (!active) return;
    let frame = 0;
    let held = Number.NEGATIVE_INFINITY;
    let heldAt = 0;
    let shown = '';
    const tick = (now: number) => {
      const level = read();
      if (level >= held || now - heldAt > 1_500) {
        held = level;
        heldAt = now;
      }
      if (bar.current) bar.current.style.width = `${meterPercent(level)}%`;
      if (hold.current) hold.current.style.left = `${meterPercent(held)}%`;
      const text = inputLevelVerdict(held) ?? '没有信号';
      if (text !== shown && verdict.current) {
        shown = text;
        verdict.current.textContent = text;
        verdict.current.dataset.verdict = text;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [read, active]);

  return (
    <div className="input-meter">
      <div className="input-meter-track" aria-hidden="true">
        <span
          className="input-meter-target"
          style={{ left: `${meterPercent(INPUT_LEVEL_TARGET.lowDbfs)}%`, width: `${meterPercent(INPUT_LEVEL_TARGET.highDbfs) - meterPercent(INPUT_LEVEL_TARGET.lowDbfs)}%` }}
        />
        <i ref={bar} />
        <b ref={hold} />
      </div>
      <p className="input-meter-caption">
        <strong ref={verdict} aria-live="polite">播放时显示电平</strong>
        <span>浅色区间是普通拾音器的电平，单块都按这个范围校准。</span>
      </p>
    </div>
  );
}

function TakeRow({ take, selected, onSelect, onRename, onDelete }: {
  take: TakeMeta;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(take.name);
  const date = new Date(take.createdAt);
  return (
    <li className={'take-row' + (selected ? ' is-selected' : '')}>
      {editing ? (
        <form
          className="take-rename"
          onSubmit={(event) => { event.preventDefault(); onRename(draft); setEditing(false); }}
        >
          <input autoFocus value={draft} maxLength={40} aria-label="录音名称" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); } }} />
          <button type="submit">保存</button>
        </form>
      ) : (
        <button type="button" className="take-select" role="radio" aria-checked={selected} onClick={onSelect}>
          <strong>{take.name}</strong>
          <small>{take.source === 'recording' ? '录制' : '上传'}，{formatSeconds(take.durationSeconds)}，{date.getMonth() + 1} 月 {date.getDate()} 日</small>
        </button>
      )}
      {!editing && <button type="button" className="take-action" onClick={() => { setDraft(take.name); setEditing(true); }}>改名</button>}
      <button type="button" className="take-action is-danger" aria-label={`删除 ${take.name}`} onClick={onDelete}>删除</button>
    </li>
  );
}

export type InputDeckProps = {
  source: SourceConfig;
  input: InputSettings;
  takes: TakeMeta[];
  /** Why the selected take is not playing (missing from this browser), if so. */
  takeNotice: string;
  playing: boolean;
  liveInputActive: boolean;
  liveInputBusy: boolean;
  recording: RecordingState;
  uploadBusy: boolean;
  tutorialEnabled: boolean;
  readLevel: () => number;
  onSource: (source: SourceConfig) => void;
  onSelectTake: (takeId: string | null) => void;
  onUpload: (file: File) => void;
  onRenameTake: (takeId: string, name: string) => void;
  onDeleteTake: (takeId: string) => void;
  onToggleLive: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onTrim: (trimDb: number) => void;
  onHelp: (target: HelpTarget) => void;
};

/**
 * The input node's deck: where the guitar comes from (an example phrase, a
 * take recorded or uploaded in this browser, or the live instrument), how
 * hot it hits the board, and the re-amping recorder.
 */
export function InputDeck(props: InputDeckProps) {
  const { source, input, takes, liveInputActive, recording } = props;
  const current: InputTab = liveInputActive ? 'live' : input.takeId ? 'takes' : 'example';
  const [tab, setTab] = useState<InputTab>(current);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Follow the source when it changes elsewhere (recording finished, live switched on).
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (lastCurrent.current !== current) {
      lastCurrent.current = current;
      setTab(current);
    }
  }, [current]);

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) props.onUpload(file);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragOver(false);
    onFiles(event.dataTransfer.files);
  };

  const tabs: Array<{ id: InputTab; label: string }> = [
    { id: 'example', label: '示例乐句' },
    { id: 'takes', label: '我的录音' },
    { id: 'live', label: '实时输入' },
  ];

  return (
    <div
      className={'input-deck' + (dragOver ? ' is-drag-over' : '')}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false); }}
      onDrop={onDrop}
    >
      <div className="input-deck-main">
        <div className="input-tabs" role="tablist" aria-label="输入来源">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`input-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`input-panel-${entry.id}`}
              className={(tab === entry.id ? 'active' : '') + (current === entry.id ? ' is-current' : '')}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}{current === entry.id && <><i aria-hidden="true" /><span className="sr-only">（正在使用）</span></>}
            </button>
          ))}
        </div>

        {props.takeNotice && <p className="input-notice" role="status">{props.takeNotice}</p>}

        {tab === 'example' && (
          <div className="input-panel" role="tabpanel" id="input-panel-example" aria-labelledby="input-tab-example">
            <p className="input-panel-lead">内置的电吉他 DI 采样拼成的乐句。{current !== 'example' && '选一个就会换回示例乐句。'}</p>
            <h3>音色</h3>
            <div className="source-choice-grid guitars" role="radiogroup" aria-label="电吉他音色">
              {GUITAR_VOICES.map((voice) => (
                <button key={voice.id} type="button" role="radio" aria-checked={current === 'example' && source.guitar === voice.id} className={current === 'example' && source.guitar === voice.id ? 'active' : ''} onClick={() => props.onSource({ ...source, guitar: voice.id })}>
                  <strong>{voice.name}</strong><small>{voice.description}</small>
                </button>
              ))}
            </div>
            <h3>演奏方式</h3>
            <div className="source-choice-grid performance" role="radiogroup" aria-label="演奏方式">
              {PERFORMANCE_SPECS.map((performance) => (
                <button key={performance.id} type="button" role="radio" aria-checked={current === 'example' && source.performance === performance.id} className={current === 'example' && source.performance === performance.id ? 'active' : ''} onClick={() => props.onSource({ ...source, performance: performance.id })}>
                  <strong>{performance.name}</strong><small>{performance.description}</small>
                </button>
              ))}
            </div>
            <h3>和弦进行</h3>
            <div className="source-choice-grid progressions" role="radiogroup" aria-label="和弦进行">
              {CHORD_PROGRESSIONS.map((progression) => (
                <button key={progression.id} type="button" role="radio" aria-checked={current === 'example' && source.progression === progression.id} className={current === 'example' && source.progression === progression.id ? 'active' : ''} onClick={() => props.onSource({ ...source, progression: progression.id })}>
                  <strong>{progression.name}</strong><small>{progression.chords}</small>
                </button>
              ))}
            </div>
            <p className="sample-license-note">
              采样来自 <a href="https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html" target="_blank" rel="noreferrer">FreePats Direct DI</a>（CC0），未经处理的直录信号。
            </p>
          </div>
        )}

        {tab === 'takes' && (
          <div className="input-panel" role="tabpanel" id="input-panel-takes" aria-labelledby="input-tab-takes">
            <div className="take-toolbar">
              <button type="button" className="take-upload" disabled={props.uploadBusy} onClick={() => fileInput.current?.click()}>
                {props.uploadBusy ? '正在读取…' : '上传音频文件'}
              </button>
              <button type="button" className="take-record" onClick={() => setTab('live')}>去录一段</button>
              <input ref={fileInput} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.aif,.aiff" onChange={(event: ChangeEvent<HTMLInputElement>) => { onFiles(event.target.files); event.target.value = ''; }} />
            </div>
            {takes.length === 0 ? (
              <p className="take-empty">
                录一次干净的 DI，就能一边循环播放一边调音色，和录音棚里的重新放大（reamp）一样。也可以直接把 WAV、MP3 拖到这里，最长 {MAX_UPLOAD_SECONDS} 秒。
              </p>
            ) : (
              <ul className="take-list" role="radiogroup" aria-label="我的录音">
                {takes.map((take) => (
                  <TakeRow
                    key={take.id}
                    take={take}
                    selected={input.takeId === take.id && !liveInputActive}
                    onSelect={() => props.onSelectTake(take.id)}
                    onRename={(name) => props.onRenameTake(take.id, name)}
                    onDelete={() => props.onDeleteTake(take.id)}
                  />
                ))}
              </ul>
            )}
            <p className="input-panel-foot">录音只保存在这个浏览器里，不会上传。音色预设只记住用的是哪段录音和循环区间。</p>
          </div>
        )}

        {tab === 'live' && (
          <div className="input-panel" role="tabpanel" id="input-panel-live" aria-labelledby="input-tab-live">
            <div className="live-controls">
              <button type="button" role="switch" aria-checked={liveInputActive} className={'live-toggle' + (liveInputActive ? ' is-on' : '')} disabled={props.liveInputBusy || Boolean(recording)} onClick={props.onToggleLive}>
                <i aria-hidden="true" />{liveInputActive ? '实时输入已打开' : '打开实时输入'}
              </button>
              {recording ? (
                <button type="button" className="rec-button is-recording" onClick={props.onStopRecording}>
                  <i aria-hidden="true" />停止录音 {formatSeconds(recording.seconds)} / {formatSeconds(MAX_RECORDING_SECONDS)}
                </button>
              ) : (
                <button type="button" className="rec-button" disabled={!liveInputActive} title={liveInputActive ? '录下不带效果的干声' : '先打开实时输入'} onClick={props.onStartRecording}>
                  <i aria-hidden="true" />录一段干声
                </button>
              )}
            </div>
            <p className="input-panel-lead">
              {liveInputActive
                ? `正在弹你自己的琴。录下的是进入单块之前的干声，最长 ${MAX_RECORDING_SECONDS} 秒，录完会自动循环播放。`
                : '用声卡的乐器输入口（Hi-Z）接吉他效果最好，内置麦克风也能用。请戴耳机，避免啸叫。'}
            </p>
          </div>
        )}
      </div>

      <aside className="input-deck-level" aria-label="输入电平">
        <div className="deck-knobs input-trim">
          <KnobControl
            control={TRIM_CONTROL}
            value={trimToKnob(input.trimDb)}
            disabled={false}
            tutorialEnabled={props.tutorialEnabled}
            ownerKind="effect"
            modelId="input"
            ownerName="输入"
            onChange={(value) => props.onTrim(knobToTrim(value))}
            onHelp={props.onHelp}
          />
        </div>
        <InputMeter read={props.readLevel} active={props.playing} />
      </aside>
      {props.uploadBusy === false && dragOver && <div className="input-drop-hint" aria-hidden="true">松开即可导入这段音频</div>}
    </div>
  );
}
