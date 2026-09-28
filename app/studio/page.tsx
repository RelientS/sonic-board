'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  createLiveSession,
  disposeLiveSession,
  refreshLiveSession,
  renderBoardToWav,
  requestInstrumentStream,
  setLiveInput,
  type BoardAudioConfig,
  type EffectStatus,
  type LiveAudioSession,
} from '../audio/audio-engine';
import { LiveSessionController } from '../audio/live-session-controller';
import type { SignalLane } from '../audio/audio-core';
import {
  createBrowserNamModelRepository,
  createNamModelRecord,
  parseNamModel,
  type NamModelRecord,
  type NamModelRepository,
} from '../audio/nam-model';
import { formatSourceConfig, type SourceConfig } from '../audio/source-catalog';
import { ToneAgentDock, type ToneAgentTurn } from '../agent/ToneAgentDock';
import {
  applyToneAgentActions,
  captureToneAgentBoard,
  type ToneAgentBoardState,
  type ToneAgentMessage,
} from '../agent/tone-agent-runtime';
import { isToneAgentAbort, requestToneAgentStream, ToneAgentHttpError } from '../agent/tone-agent-stream';
import { AMP_SPECS, getAmpSpec, isNamAmp, listNamAmps, NAM_AMP_PREFIX, registerNamAmps } from '../amps/catalog';
import { FACTORY_PRESETS, instantiatePreset, type EffectSpec } from '../effects/catalog';
import { captureUserPreset, instantiateUserPreset, parseUserPresets, type UserPreset } from '../effects/user-presets';
import { Board } from './Board';
import {
  boardFromPreset,
  captureLayout,
  cloneBoardUiState,
  laneItems,
  laneOf,
  MAX_PEDALS,
  nodeOrder,
  RIG_NODE,
  spotForCableInsert,
  type BoardUiState,
  type SnapshotId,
} from './board-store';
import type { FlowDirection } from './board-geometry';
import type { Cable } from './patch-graph';
import { FlowList } from './FlowList';
import { FocusDeck } from './FocusDeck';
import { ControlHelpDialog, type HelpTarget } from './Knob';
import { PedalPicker, type PickerTarget } from './PedalPicker';
import { PresetBrowser } from './PresetBrowser';
import { rigModeOf, type RigMode } from './rig-model';
import { keyTargetOf, shortcutFor, type Shortcut } from './shortcuts';
import { focusNodeElement } from './studio-shared';
import { Topbar } from './Topbar';
import { SourcePickerDialog, Transport } from './Transport';
import { useBoard } from './useBoard';
import './studio.css';

type AgentUndoEntry = {
  baseline: BoardUiState;
  appliedRevision: number;
};
type PrivateAmpSummary = { id: string; amp: string; setting: string; author?: string; url?: string; loudness?: number | null; format?: 'combo' | 'head'; cab?: string };

const initialFactoryPreset = FACTORY_PRESETS.find((preset) => preset.id === 'reverse-wall') ?? FACTORY_PRESETS[0];
// Fixed instance ids so the server and the client render the same board.
const initialBoard = instantiatePreset(initialFactoryPreset, 'initial');

/** Minimum spacing between live audio updates while a knob is dragged. */
const PLAYBACK_REFRESH_INTERVAL_MS = 30;

type PrivatePedalModel = { id: string; slotId: string; name: string; setting: string; author?: string; url?: string; loudness?: number | null };
const PRIVATE_NAM_STORAGE_PREFIX = 'sonic-board-private-nam:';

function readStoredPrivateNam(slotId: string) {
  try {
    return window.localStorage.getItem(PRIVATE_NAM_STORAGE_PREFIX + slotId);
  } catch {
    return null;
  }
}

const PHONE_QUERY = '(max-width: 720px)';
function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
/** Phones get the vertical signal-flow list instead of the drawn board. */
function useIsPhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

export default function Studio() {
  const board = useBoard(() => boardFromPreset(initialBoard, initialFactoryPreset.name));
  const { state, dispatch } = board;
  const { chain, snapshots, snapshot, selected, bypassed, source, routing, amp, output, mode, activePresetName } = state;
  const values = snapshots[snapshot];
  const boardRevision = board.revision;
  const isPhone = useIsPhone();

  const [deckOpen, setDeckOpen] = useState(false);
  const deckHeading = useRef<HTMLHeadingElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  // A '+' on a patch cable: the picked pedal goes into that cable.
  const [pickerCable, setPickerCable] = useState<Cable | null>(null);
  // Top-down photos by spec id, only for the owner account (licensed for personal use).
  const [pedalSkins, setPedalSkins] = useState<Record<string, string>>({});
  // Built-in pedal NAM captures (owner only) and the one chosen per NAM slot.
  const [privatePedalModels, setPrivatePedalModels] = useState<PrivatePedalModel[]>([]);
  const [privateNam, setPrivateNam] = useState<Record<string, NamModelRecord>>({});
  const [privateNamIds, setPrivateNamIds] = useState<Record<string, string>>({});
  // Signal direction on the board: null follows the default (right-to-left with photos).
  const [flowSetting, setFlowSetting] = useState<FlowDirection | null>(null);
  const flowDirection: FlowDirection = flowSetting ?? (Object.keys(pedalSkins).length ? 'rtl' : 'ltr');
  const [presetOpen, setPresetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  // The rig's combo/head view is null until the player switches it, so it
  // follows the current amp's own format by default.
  const [rigView, setRigView] = useState<RigMode | null>(null);
  const [liveInputOn, setLiveInputOn] = useState(false);
  const [liveInputBusy, setLiveInputBusy] = useState(false);
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
  const [agentInput, setAgentInput] = useState('');
  const [agentTurns, setAgentTurns] = useState<ToneAgentTurn[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [audioError, setAudioError] = useState('');
  const [namModels, setNamModels] = useState<Record<string, NamModelRecord>>({});
  // A model the player imported into this browser wins over a built-in capture.
  const activeNamModels = useMemo(() => ({ ...privateNam, ...namModels }), [privateNam, namModels]);
  // Owner-only NAM amp captures: the list, and the selected capture's model.
  const [namAmps, setNamAmps] = useState<PrivateAmpSummary[]>([]);
  const [ampModel, setAmpModel] = useState<BoardAudioConfig['ampModel']>(undefined);
  const ampModelCache = useRef(new Map<string, string>());
  const [namImporting, setNamImporting] = useState('');
  const [playback] = useState(() => new LiveSessionController<BoardAudioConfig, LiveAudioSession>(createLiveSession, disposeLiveSession));
  const previousMonitorMode = useRef(mode);
  const helpInvoker = useRef<HTMLElement | null>(null);
  const agentAbort = useRef<AbortController | null>(null);
  const playbackLoadingRef = useRef(false);
  const playbackRefreshSerial = useRef(0);
  const lastPlaybackRefreshAt = useRef(0);
  const [effectStatus, setEffectStatus] = useState<ReadonlyMap<string, EffectStatus>>(() => new Map());
  const agentTurnSerial = useRef(0);
  const agentUndo = useRef(new Map<string, AgentUndoEntry>());
  const manualPedalSerial = useRef(0);
  const namRepository = useRef<NamModelRepository | null>(null);
  const dryKeyHeld = useRef(false);
  const ampSpec = getAmpSpec(amp.ampId);

  const audioConfig = useMemo<BoardAudioConfig>(() => ({
    chain,
    values,
    bypassed: [...bypassed],
    source,
    mode,
    output,
    routing,
    amp,
    namModels: activeNamModels,
    ampModel: ampModel?.id === amp.ampId ? ampModel : undefined,
  }), [chain, values, bypassed, source, mode, output, routing, amp, activeNamModels, ampModel]);

  const refreshNamAmps = useCallback(() => {
    void fetch('/api/amp-models', { credentials: 'same-origin' })
      .then((response): Promise<{ amps?: PrivateAmpSummary[] }> => (response.ok ? response.json() : Promise.resolve({ amps: [] })))
      .then((payload) => {
        const amps = Array.isArray(payload.amps) ? payload.amps : [];
        registerNamAmps(amps);
        setNamAmps(amps);
      })
      .catch(() => { /* offline: the built-in amps still work */ });
    void fetch('/api/private-assets', { credentials: 'same-origin' })
      .then((response): Promise<{ skins?: Array<{ specId: string }>; pedalModels?: PrivatePedalModel[] }> => (response.ok ? response.json() : Promise.resolve({})))
      .then((payload) => {
        const skins = Array.isArray(payload.skins) ? payload.skins : [];
        setPedalSkins(Object.fromEntries(skins.map((skin) => [skin.specId, '/api/private-assets?skin=' + encodeURIComponent(skin.specId)])));
        const models = Array.isArray(payload.pedalModels) ? payload.pedalModels : [];
        setPrivatePedalModels(models);
        if (!models.length) setPrivateNam({});
        // Load the remembered (or first) capture for each slot.
        new Set(models.map((model) => model.slotId)).forEach((slotId) => {
          const remembered = readStoredPrivateNam(slotId);
          const choice = models.find((model) => model.slotId === slotId && model.id === remembered) ?? models.find((model) => model.slotId === slotId);
          if (choice) void loadPrivatePedalModel(choice);
        });
      })
      .catch(() => { /* offline: drawn pedals and local models still work */ });
  }, []);

  useEffect(() => {
    refreshNamAmps();
  }, [refreshNamAmps]);

  // Load the selected capture (cached per session; the server only serves it to the owner).
  const namAmpId = isNamAmp(amp.ampId) ? amp.ampId : null;
  useEffect(() => {
    if (!namAmpId) return;
    const id = namAmpId.slice(NAM_AMP_PREFIX.length);
    const loudness = namAmps.find((entry) => entry.id === id)?.loudness ?? null;
    const cached = ampModelCache.current.get(id);
    if (cached) {
      setAmpModel({ id: namAmpId, modelJson: cached, loudness });
      return;
    }
    let active = true;
    void fetch('/api/amp-models?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((modelJson) => {
        ampModelCache.current.set(id, modelJson);
        if (active) setAmpModel({ id: namAmpId, modelJson, loudness });
      })
      .catch(() => { if (active) setAudioError('NAM 箱头模型加载失败（需要所有者账号登录）。'); });
    return () => { active = false; };
  }, [namAmpId, namAmps]);
  const toneAgentBoard = useMemo<ToneAgentBoardState>(() => captureToneAgentBoard({
    name: activePresetName,
    selectedInstanceId: chain.some((item) => item.instanceId === selected) ? selected : chain[0]?.instanceId ?? '',
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

  function captureCurrentBoardUiState(): BoardUiState {
    return cloneBoardUiState(board.latest.current);
  }

  function restoreBoardUiState(snapshotState: BoardUiState) {
    dispatch({ type: 'restore', state: snapshotState });
    setAudioError('');
  }

  function applyToneAgentBoard(nextBoard: ToneAgentBoardState, replaceSnapshots = false) {
    dispatch({ type: 'applyAgent', board: nextBoard, replaceSnapshots });
    setAudioError('');
  }

  function applyPreset(nextBoard: ReturnType<typeof instantiatePreset>, name: string) {
    dispatch({ type: 'applyPreset', board: nextBoard, name });
    setAudioError('');
    setPresetOpen(false);
  }

  function resetBoard() {
    applyPreset(instantiatePreset(initialFactoryPreset), initialFactoryPreset.name);
  }

  function loadFactoryPreset(id: string) {
    const preset = FACTORY_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    applyPreset(instantiatePreset(preset), preset.name);
  }

  function loadUserPreset(preset: UserPreset) {
    applyPreset(instantiateUserPreset(preset), preset.name);
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

  function getNamRepository() {
    const repository = namRepository.current ?? createBrowserNamModelRepository();
    namRepository.current = repository;
    return repository;
  }

  async function loadPrivatePedalModel(model: PrivatePedalModel) {
    try {
      const response = await fetch('/api/private-assets?pedalModel=' + encodeURIComponent(model.id), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = parseNamModel(await response.text(), model.id + '.nam');
      const record = createNamModelRecord(model.slotId, { ...parsed, name: `${model.name}（${model.setting}）` });
      setPrivateNam((current) => ({ ...current, [model.slotId]: record }));
      setPrivateNamIds((current) => ({ ...current, [model.slotId]: model.id }));
      try { window.localStorage.setItem(PRIVATE_NAM_STORAGE_PREFIX + model.slotId, model.id); } catch { /* storage is optional */ }
    } catch {
      setAudioError('内置 NAM 采样加载失败（需要所有者账号登录）。');
    }
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

  function namSection(spec: EffectSpec) {
    if (!spec.nam) return null;
    const localModel = namModels[spec.nam.slotId];
    const builtIn = privatePedalModels.filter((model) => model.slotId === spec.nam!.slotId);
    const builtInActive = !localModel ? privateNam[spec.nam.slotId] : undefined;
    if (builtIn.length && !localModel) {
      return <div className="nam-local-actions">
        <div className="nam-model-state loaded">
          <strong>{builtInActive ? `内置采样：${builtInActive.name}` : '正在加载内置采样…'}</strong>
          <small>Tone3000 上的真实采样，仅你的账号可用。也可以导入自己的 .nam 替换。</small>
        </div>
        <label className="nam-builtin-select">
          <span>采样</span>
          <select
            value={privateNamIds[spec.nam.slotId] ?? builtIn[0].id}
            onChange={(event) => {
              const choice = builtIn.find((model) => model.id === event.target.value);
              if (choice) void loadPrivatePedalModel(choice);
            }}
          >
            {builtIn.map((model) => <option key={model.id} value={model.id}>{model.name}（{model.setting}）</option>)}
          </select>
        </label>
        <label className={'nam-import' + (namImporting === spec.nam.slotId ? ' disabled' : '')}>
          <input
            className="nam-file-input"
            type="file"
            accept=".nam"
            disabled={namImporting === spec.nam.slotId}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              void importNamModel(spec, file);
            }}
          />
          导入自己的 .nam
        </label>
      </div>;
    }
    const busy = namImporting === spec.nam.slotId;
    return <div className="nam-local-actions">
      <div className={'nam-model-state ' + (localModel ? 'loaded' : 'missing')}>
        <strong>{localModel ? `本机已加载：${localModel.name}` : '本机未加载 NAM'}</strong>
        <small>{localModel ? `${localModel.architecture} · ${Math.round(localModel.sampleRate / 100) / 10} kHz` : '没有模型时这块安全直通，不会静音。'}</small>
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
  }

  // ----- Board navigation and edits -------------------------------------

  function openNode(id: string, fromKeyboard = false) {
    dispatch({ type: 'focus', id });
    setDeckOpen(true);
    if (fromKeyboard) window.requestAnimationFrame(() => deckHeading.current?.focus());
  }

  function closeDeck() {
    setDeckOpen(false);
    focusNodeElement(board.latest.current.selected);
  }

  /** Focus a node: the deck follows, and keyboard focus follows if it was on the board. */
  function focusNode(id: string) {
    dispatch({ type: 'focus', id });
    const active = document.activeElement as HTMLElement | null;
    if (active?.dataset?.nodeId || !deckOpen) focusNodeElement(id);
  }

  function stepFocus(direction: -1 | 1) {
    const order = nodeOrder(board.latest.current);
    const at = order.indexOf(board.latest.current.selected);
    const next = order[Math.max(0, Math.min(order.length - 1, (at < 0 ? 0 : at) + direction))];
    if (next) focusNode(next);
  }

  function requestInsert(lane: SignalLane, index: number) {
    const row = laneItems(chain, routing.mode, lane);
    setPickerCable(null);
    setPickerTarget({ lane, index, atEnd: index >= row.length });
    setPickerOpen(true);
  }

  /** A short-lived message for refused board edits (clears itself). */
  function showNotice(message: string) {
    setAudioError(message);
    window.setTimeout(() => setAudioError((current) => (current === message ? '' : current)), 2600);
  }

  function requestInsertOnCable(cable: Cable) {
    setPickerCable(cable);
    setPickerTarget({ lane: 'A', index: 0, atEnd: false, cableLabel: '这根线上' });
    setPickerOpen(true);
  }

  /** ⌘K / "添加效果器": add after the last pedal of the focused pedal's lane. */
  function openPickerAtEnd() {
    const focusedPedal = chain.find((item) => item.instanceId === selected);
    const lane = routing.mode === 'parallel' && focusedPedal ? laneOf(focusedPedal) : 'A';
    setPickerCable(null);
    setPickerTarget({ lane, index: laneItems(chain, routing.mode, lane).length, atEnd: true });
    setPickerOpen(true);
  }

  function pickPedal(specId: string) {
    const current = board.latest.current;
    if (current.chain.length + current.parked.length >= MAX_PEDALS) {
      setAudioError('当前板面最多放 16 块效果器，请先移除一块。');
      return;
    }
    const target = pickerTarget ?? { lane: 'A' as const, index: chain.length, atEnd: true };
    manualPedalSerial.current += 1;
    const instanceId = `${specId}-manual-${manualPedalSerial.current}`;
    if (pickerCable) dispatch({ type: 'insertOnCable', specId, instanceId, cable: pickerCable, at: spotForCableInsert(current, pickerCable, specId) ?? undefined });
    else dispatch({ type: 'add', specId, instanceId, lane: target.lane, index: target.index });
    setPickerCable(null);
    setPickerOpen(false);
    setDeckOpen(true);
    focusNodeElement(instanceId);
  }

  function removePedal(instanceId: string) {
    const removedFocus = board.latest.current.selected === instanceId;
    dispatch({ type: 'remove', instanceId });
    if (removedFocus) focusNodeElement(board.latest.current.selected);
  }

  function assignLane(instanceId: string, lane: SignalLane) {
    dispatch({ type: 'move', instanceId, lane, slot: laneItems(chain, 'parallel', lane).length });
  }

  function toggleBypass(instanceId: string) {
    dispatch({ type: 'bypass', instanceId });
  }

  function updateSource(next: SourceConfig) {
    dispatch({ type: 'setSource', source: next });
  }

  function selectSnapshot(next: SnapshotId) {
    dispatch({ type: 'selectSnapshot', snapshot: next });
  }

  /** Press-and-hold monitoring: dry while held. Not an edit, so not undoable. */
  function holdDry(held: boolean) {
    dispatch({ type: 'setMode', mode: held ? 'dry' : 'wet' });
  }

  function openControlHelp(target: HelpTarget) {
    helpInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHelpTarget(target);
  }

  function closeControlHelp() {
    setHelpTarget(null);
    window.requestAnimationFrame(() => helpInvoker.current?.focus());
  }

  // ----- Keyboard map ----------------------------------------------------

  const runShortcut = useRef<(shortcut: Shortcut) => void>(() => {});
  useEffect(() => {
    runShortcut.current = (shortcut) => {
      const current = board.latest.current;
      const focusedPedal = current.chain.find((item) => item.instanceId === current.selected);
      switch (shortcut.type) {
        case 'play': void togglePlayback(); break;
        case 'bypass':
          if (focusedPedal) toggleBypass(focusedPedal.instanceId);
          else if (current.selected === RIG_NODE) dispatch({ type: 'toggleAmpBypass' });
          break;
        case 'focusPrev': stepFocus(-1); break;
        case 'focusNext': stepFocus(1); break;
        case 'movePrev': if (focusedPedal) dispatch({ type: 'nudge', instanceId: focusedPedal.instanceId, direction: -1 }); break;
        case 'moveNext': if (focusedPedal) dispatch({ type: 'nudge', instanceId: focusedPedal.instanceId, direction: 1 }); break;
        case 'focusIndex': {
          const id = nodeOrder(current)[shortcut.index];
          if (id) focusNode(id);
          break;
        }
        case 'picker': openPickerAtEnd(); break;
        case 'remove': if (focusedPedal) removePedal(focusedPedal.instanceId); break;
        case 'close': if (deckOpen) closeDeck(); break;
        case 'undo': board.undo(); break;
        case 'redo': board.redo(); break;
        case 'dryHold': dryKeyHeld.current = true; holdDry(true); break;
        case 'help': setShortcutsOpen(true); break;
      }
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modalOpen = Boolean(document.querySelector('dialog[open], [aria-modal="true"]'));
      const shortcut = shortcutFor(event, { target: keyTargetOf(event.target), modalOpen });
      if (!shortcut) return;
      event.preventDefault();
      runShortcut.current(shortcut);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'd' || !dryKeyHeld.current) return;
      dryKeyHeld.current = false;
      dispatch({ type: 'setMode', mode: 'wet' });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [dispatch]);

  // ----- Playback, live input, presets, export ---------------------------

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

  function saveCurrentPreset(name: string) {
    if (chain.length === 0) {
      setAudioError('空效果器链无法保存。');
      return;
    }
    try {
      const captured = captureUserPreset({ name, chain, parked: state.parked, layout: captureLayout(state), values, bypassed, source, output, routing, amp });
      const next = [captured, ...userPresets].slice(0, 24);
      window.localStorage.setItem('sonic-board-user-presets', JSON.stringify(next));
      setUserPresets(next);
      dispatch({ type: 'rename', name: captured.name });
      setSaveState('saved');
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
      window.setTimeout(() => setRender('idle'), 2500);
    } catch {
      setRender('idle');
      setAudioError('音频导出失败，请减少长混响后再试。');
    }
  }

  const sourceLabel = liveInputActive ? '实时输入（声卡 / 麦克风）' : formatSourceConfig(source);
  const nodeProps = {
    state,
    values,
    deckOpen,
    lit: playing && mode === 'wet' && !amp.bypassed,
    sourceLabel,
    engineStatus: (instanceId: string) => (playing ? effectStatus.get(instanceId) : undefined),
    namLoaded: (spec: EffectSpec) => !spec.nam || Boolean(activeNamModels[spec.nam.slotId]),
    onOpenNode: openNode,
    onBypass: toggleBypass,
    onInsert: requestInsert,
    onMove: (instanceId: string, lane: SignalLane, slot: number) => { dispatch({ type: 'move', instanceId, lane, slot }); },
    onOpenInput: () => setSourcePickerOpen(true),
    onConnectParked: (instanceId: string) => { dispatch({ type: 'connectParked', instanceId, lane: 'A' }); },
  };
  const statusText = playbackLoading ? '正在加载试听，请稍候；重复点击不会中断加载。' : render === 'ready' ? 'WAV 音频已下载' : saveState === 'saved' ? '音色已保存在当前浏览器' : '';

  return (
    <main className={'studio' + (deckOpen ? ' deck-open' : '') + (isPhone ? ' is-phone' : '')}>
      <a className="skip-link" href="#board">跳到效果器板</a>
      <Topbar
        activePresetName={activePresetName}
        canUndo={board.historyState.canUndo}
        canRedo={board.historyState.canRedo}
        agentOpen={agentOpen}
        tutorialEnabled={tutorialEnabled}
        presetOpen={presetOpen}
        shortcutsOpen={shortcutsOpen}
        onOpenPresets={() => setPresetOpen(true)}
        onUndo={board.undo}
        onRedo={board.redo}
        onAddPedal={openPickerAtEnd}
        onToggleAgent={() => setAgentOpen((current) => !current)}
        onTutorialChange={(enabled) => { setTutorialEnabled(enabled); if (!enabled) setHelpTarget(null); }}
        onShortcutsOpenChange={setShortcutsOpen}
        onAccountChange={refreshNamAmps}
      />

      <section id="board" className="stage" aria-label="效果器板">
        {isPhone ? <FlowList {...nodeProps} /> : (
          <Board
            {...nodeProps}
            direction={flowDirection}
            skins={pedalSkins}
            onPlace={(id, x, y) => { dispatch({ type: 'place', id, x, y }); }}
            onPatch={(cables) => { dispatch({ type: 'patch', cables }); }}
            onInsertOnCable={requestInsertOnCable}
            onTidy={() => { dispatch({ type: 'tidy' }); }}
            onDirectionChange={setFlowSetting}
            onNotice={showNotice}
          />
        )}
      </section>

      <FocusDeck
        ref={deckHeading}
        open={deckOpen}
        state={state}
        values={values}
        tutorialEnabled={tutorialEnabled}
        rigView={rigView ?? rigModeOf(ampSpec)}
        amps={[...AMP_SPECS, ...(namAmps.length ? listNamAmps() : [])]}
        engineStatus={nodeProps.engineStatus}
        namLoaded={nodeProps.namLoaded}
        namSection={namSection}
        onClose={closeDeck}
        onStep={stepFocus}
        onNudge={(instanceId, direction) => { dispatch({ type: 'nudge', instanceId, direction }); }}
        onConnectParked={nodeProps.onConnectParked}
        onLane={assignLane}
        onBypass={toggleBypass}
        onRemove={removePedal}
        onValue={(instanceId, controlId, value) => { dispatch({ type: 'setValue', instanceId, controlId, value }); }}
        onRouting={(next) => { dispatch({ type: 'setRouting', routing: next }); }}
        onRigViewChange={setRigView}
        onPickCombo={(ampId) => { dispatch({ type: 'selectCombo', ampId }); }}
        onPickHead={(ampId) => { dispatch({ type: 'selectHead', ampId }); }}
        onPickCab={(cabId) => { dispatch({ type: 'selectCab', cabId }); }}
        onAmpValue={(section, controlId, value) => { dispatch({ type: 'setAmpValue', section, controlId, value }); }}
        onToggleAmpBypass={() => { dispatch({ type: 'toggleAmpBypass' }); }}
        onHelp={openControlHelp}
      />

      <Transport
        playback={playback}
        playing={playing}
        playbackLoading={playbackLoading}
        source={source}
        liveInputActive={liveInputActive}
        mode={mode}
        dryHeld={mode === 'dry'}
        snapshot={snapshot}
        output={output}
        render={render}
        audioError={audioError}
        statusText={statusText}
        onTogglePlayback={() => void togglePlayback()}
        onOpenInput={() => setSourcePickerOpen(true)}
        onHoldDry={holdDry}
        onSnapshot={selectSnapshot}
        onCopySnapshot={() => { dispatch({ type: 'copySnapshot' }); }}
        onOutput={(next) => { dispatch({ type: 'setOutput', output: next }); }}
        onExport={() => void exportWav()}
      />

      <PedalPicker
        open={pickerOpen}
        target={pickerTarget}
        parallel={routing.mode === 'parallel'}
        full={chain.length >= MAX_PEDALS}
        onPick={pickPedal}
        onClose={() => setPickerOpen(false)}
      />
      <PresetBrowser
        open={presetOpen}
        activePresetName={activePresetName}
        userPresets={userPresets}
        saveState={saveState}
        onLoadFactory={loadFactoryPreset}
        onLoadUser={loadUserPreset}
        onSave={saveCurrentPreset}
        onDelete={deleteUserPreset}
        onReset={resetBoard}
        onClose={() => setPresetOpen(false)}
      />
      <SourcePickerDialog
        open={sourcePickerOpen}
        source={source}
        liveInputActive={liveInputActive}
        liveInputBusy={liveInputBusy || playbackLoading}
        onChange={updateSource}
        onLiveInput={() => void toggleLiveInput()}
        onClose={() => setSourcePickerOpen(false)}
      />
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
    </main>
  );
}
