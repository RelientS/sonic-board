'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  loadExampleSourceChannel,
  readInputPeakDbfs,
  startInputRecording,
  type BoardAudioConfig,
  type InputRecording,
  type InputTake,
  type LiveAudioSession,
} from '../audio/audio-engine.ts';
import type { LiveSessionController } from '../audio/live-session-controller.ts';
import { formatSourceConfig, type LoopRegion, type SourceConfig } from '../audio/source-catalog.ts';
import {
  createBrowserTakeStorage,
  decodeTakeFile,
  makeRecordedTake,
  MAX_RECORDING_SECONDS,
  type TakeMeta,
  type TakeStorage,
} from '../audio/takes-store.ts';
import { computePeaks, type WaveformPeaks } from '../audio/waveform.ts';
import type { BoardAction, BoardUiState } from './board-store.ts';
import type { RecordingState } from './InputDeck.tsx';

const WAVE_BUCKETS = 480;

type Playback = LiveSessionController<BoardAudioConfig, LiveAudioSession>;

/**
 * Everything about what feeds the board: takes kept in this browser (list,
 * upload, rename, delete, the selected take's audio), the re-amping
 * recorder, the source waveform, and the `input` part of the audio config.
 * Board state holds only the take id, loop and trim (undoable); audio never
 * enters board state, presets or undo history.
 */
export function useInputSource({ state, dispatch, playback, playing, liveInputActive, stopLiveInput, onError }: {
  state: BoardUiState;
  dispatch: (action: BoardAction) => boolean;
  playback: Playback;
  playing: boolean;
  liveInputActive: boolean;
  /** Switches the live input off so a fresh recording can loop. */
  stopLiveInput: () => void;
  onError: (message: string) => void;
}) {
  const { source, input } = state;
  const store = useRef<TakeStorage | null>(null);
  const [takes, setTakes] = useState<TakeMeta[]>([]);
  const [take, setTake] = useState<InputTake | null>(null);
  const [missingTake, setMissingTake] = useState<string | null>(null);
  const [examplePeaks, setExamplePeaks] = useState<{ key: string; peaks: WaveformPeaks } | null>(null);
  const [recording, setRecording] = useState<RecordingState>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const recorder = useRef<InputRecording | null>(null);
  const takeCache = useRef(new Map<string, InputTake>());

  const storage = useCallback(() => {
    store.current ??= createBrowserTakeStorage();
    return store.current;
  }, []);

  const refreshTakes = useCallback(async () => {
    try {
      setTakes(await storage().list());
    } catch {
      setTakes([]);
    }
  }, [storage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshTakes(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshTakes]);

  // Load the selected take's audio (cached for the session).
  const takeId = input.takeId;
  useEffect(() => {
    if (!takeId) return;
    const cached = takeCache.current.get(takeId);
    let active = true;
    const load = cached ? Promise.resolve(cached) : storage().get(takeId).then((record) => {
      if (!record) return null;
      const loaded = { id: record.id, sampleRate: record.sampleRate, channel: record.channel };
      takeCache.current.set(record.id, loaded);
      return loaded;
    });
    void load.then((loaded) => {
      if (!active) return;
      setTake(loaded);
      setMissingTake(loaded ? null : takeId);
    }).catch(() => {
      if (!active) return;
      setTake(null);
      setMissingTake(takeId);
    });
    return () => { active = false; };
  }, [takeId, storage]);

  const takeReady = Boolean(takeId && take?.id === takeId);
  const takeMissing = Boolean(takeId && missingTake === takeId);

  // The example phrase's waveform (only rendered when no take is playing).
  const exampleKey = `${source.guitar}:${source.performance}:${source.progression}`;
  useEffect(() => {
    if (takeId && !takeMissing) return;
    let active = true;
    void loadExampleSourceChannel(source)
      .then(({ channel, sampleRate }) => {
        if (active) setExamplePeaks({ key: exampleKey, peaks: computePeaks(channel, sampleRate, WAVE_BUCKETS) });
      })
      .catch(() => { /* the waveform stays empty; playback is unaffected */ });
    return () => { active = false; };
  }, [exampleKey, source, takeId, takeMissing]);

  const peaks = useMemo<WaveformPeaks | null>(() => {
    if (takeReady && take) return computePeaks(take.channel, take.sampleRate, WAVE_BUCKETS);
    if (takeId && !takeMissing) return null;
    return examplePeaks?.key === exampleKey ? examplePeaks.peaks : null;
  }, [takeReady, take, takeId, takeMissing, examplePeaks, exampleKey]);

  const takeMeta = takes.find((entry) => entry.id === takeId) ?? null;
  const configInput = useMemo<BoardAudioConfig['input']>(() => ({
    trimDb: input.trimDb,
    // A loop set on a take that is missing would not fit the example phrase.
    loop: takeMissing ? null : input.loop,
    take: takeReady && take ? take : undefined,
  }), [input.trimDb, input.loop, takeMissing, takeReady, take]);

  const sourceName = liveInputActive
    ? '声卡 / 麦克风'
    : takeId && !takeMissing
      ? takeMeta?.name ?? '我的录音'
      : formatSourceConfig(source);
  const takeNotice = takeMissing ? '这个音色用的录音不在当前浏览器里（可能是在别的设备上录的），先用示例乐句代替。' : '';

  const selectTake = useCallback((id: string | null) => {
    dispatch({ type: 'setInput', input: { takeId: id, loop: null } });
    if (id && liveInputActive) stopLiveInput();
  }, [dispatch, liveInputActive, stopLiveInput]);

  const setExample = useCallback((next: SourceConfig) => {
    dispatch({ type: 'setSource', source: next });
    if (liveInputActive) stopLiveInput();
  }, [dispatch, liveInputActive, stopLiveInput]);

  const setLoop = useCallback((loop: LoopRegion | null) => {
    dispatch({ type: 'setInput', input: { loop } });
  }, [dispatch]);

  const setTrim = useCallback((trimDb: number) => {
    dispatch({ type: 'setInput', input: { trimDb } });
  }, [dispatch]);

  const addTake = useCallback(async (record: Awaited<ReturnType<typeof decodeTakeFile>>) => {
    await storage().put(record);
    takeCache.current.set(record.id, { id: record.id, sampleRate: record.sampleRate, channel: record.channel });
    await refreshTakes();
    dispatch({ type: 'setInput', input: { takeId: record.id, loop: null } });
  }, [dispatch, refreshTakes, storage]);

  const upload = useCallback(async (file: File) => {
    setUploadBusy(true);
    try {
      await addTake(await decodeTakeFile(file));
      if (liveInputActive) stopLiveInput();
    } catch (error) {
      onError(error instanceof Error ? error.message : '导入音频失败。');
    } finally {
      setUploadBusy(false);
    }
  }, [addTake, liveInputActive, onError, stopLiveInput]);

  const renameTake = useCallback(async (id: string, name: string) => {
    await storage().rename(id, name);
    await refreshTakes();
  }, [refreshTakes, storage]);

  const deleteTake = useCallback(async (id: string) => {
    await storage().remove(id);
    takeCache.current.delete(id);
    await refreshTakes();
    if (id === takeId) dispatch({ type: 'setInput', input: { takeId: null, loop: null } });
  }, [dispatch, refreshTakes, storage, takeId]);

  const startRecording = useCallback(async () => {
    const session = playback.current;
    if (!session || !liveInputActive || recorder.current) return;
    try {
      const active = await startInputRecording(session, {
        maxSeconds: MAX_RECORDING_SECONDS,
        onProgress: ({ seconds, peakDbfs }) => setRecording({ seconds, peakDbfs }),
      });
      recorder.current = active;
      setRecording({ seconds: 0, peakDbfs: Number.NEGATIVE_INFINITY });
      void active.finished.then(async (result) => {
        recorder.current = null;
        setRecording(null);
        if (result.reason === 'cancelled') return;
        if (result.channel.length < result.sampleRate * 0.25) {
          onError('录音太短了，至少录 0.25 秒。');
          return;
        }
        const count = (await storage().list()).filter((entry) => entry.source === 'recording').length + 1;
        await addTake(makeRecordedTake(result.channel, result.sampleRate, `录音 ${count}`));
        // Loop the new take through the board straight away.
        stopLiveInput();
      }).catch(() => onError('录音保存失败，请检查浏览器存储权限。'));
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法开始录音。');
    }
  }, [addTake, liveInputActive, onError, playback, stopLiveInput, storage]);

  const stopRecording = useCallback(() => {
    void recorder.current?.stop();
  }, []);

  const readLevel = useCallback(() => readInputPeakDbfs(playback.current), [playback]);

  return {
    configInput,
    sourceName,
    peaks,
    loop: takeMissing ? null : input.loop,
    setLoop,
    deck: {
      source,
      input,
      takes,
      takeNotice,
      playing,
      recording,
      uploadBusy,
      readLevel,
      onSource: setExample,
      onSelectTake: selectTake,
      onUpload: (file: File) => void upload(file),
      onRenameTake: (id: string, name: string) => void renameTake(id, name),
      onDeleteTake: (id: string) => void deleteTake(id),
      onStartRecording: () => void startRecording(),
      onStopRecording: stopRecording,
      onTrim: setTrim,
    },
  };
}
