import { AMP_SPECS, CAB_SPECS, getAmpSpec, getCabSpec, makeAmpCabConfig, type AmpCabConfig } from '../amps/catalog.ts';
import type { RoutingConfig, SignalLane } from '../audio/audio-core.ts';
import {
  CHORD_PROGRESSIONS,
  GUITAR_VOICES,
  PERFORMANCE_SPECS,
  getChordProgression,
  getGuitarVoice,
  getPerformanceSpec,
  type SourceConfig,
} from '../audio/source-catalog.ts';
import { EFFECT_SPECS, getEffectSearchText, getEffectSpec, instantiatePreset, makeDefaultValues, type EffectCategory, type FactoryPreset } from '../effects/catalog.ts';
import { getControlHelp } from '../effects/control-help.ts';
import { getEffectFidelity } from '../effects/fidelity.ts';

export type ToneAgentBoardState = {
  name: string;
  selectedInstanceId?: string;
  chain: Array<{ instanceId: string; specId: string; lane: SignalLane }>;
  values: Record<string, Record<string, number>>;
  bypassed: string[];
  source: SourceConfig;
  routing: RoutingConfig;
  amp: AmpCabConfig;
  output: number;
  monitorMode: 'dry' | 'wet';
};

export type ToneAgentAction =
  | { type: 'replace_board'; name: string; preset: FactoryPreset }
  | { type: 'update_effect'; instanceId: string; values: Record<string, number> }
  | { type: 'add_effect'; instanceId: string; specId: string; lane: SignalLane; position: number; values?: Record<string, number> }
  | { type: 'remove_effect'; instanceId: string }
  | { type: 'move_effect'; instanceId: string; position: number; lane?: SignalLane }
  | { type: 'set_bypass'; instanceId: string; bypassed: boolean }
  | { type: 'set_routing'; routing: RoutingConfig }
  | { type: 'set_amp_cab'; amp: AmpCabConfig }
  | { type: 'set_source'; source: SourceConfig }
  | { type: 'set_output'; value: number }
  | { type: 'set_monitor'; mode: 'dry' | 'wet' };

export type ToneAgentTraceStep = {
  id: string;
  kind: 'observe' | 'tool-call' | 'tool-result';
  status: 'completed' | 'failed';
  title: string;
  detail: string;
  toolName?: string;
};

export type ToneAgentPlan = {
  message: string;
  actions: ToneAgentAction[];
  provider: 'pi' | 'local';
  trace: ToneAgentTraceStep[];
};

export type ToneAgentMessage = { role: 'user' | 'assistant'; content: string };

export type ToneAgentStreamEvent =
  | { type: 'heartbeat' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'trace'; step: ToneAgentTraceStep }
  | { type: 'complete'; plan: ToneAgentPlan }
  | { type: 'error'; error: string };

export type ToneAgentRequest = {
  instruction: string;
  context: ToneAgentBoardState;
  history: ToneAgentMessage[];
};

const effectIds = new Set(EFFECT_SPECS.map((entry) => entry.id));
const guitarIds = new Set(GUITAR_VOICES.map((entry) => entry.id));
const performanceIds = new Set(PERFORMANCE_SPECS.map((entry) => entry.id));
const progressionIds = new Set(CHORD_PROGRESSIONS.map((entry) => entry.id));
const ampIds = new Set(AMP_SPECS.map((entry) => entry.id));
const cabIds = new Set(CAB_SPECS.map((entry) => entry.id));
const MAX_TONE_AGENT_ACTIONS = 16;
const MAX_TONE_AGENT_CHAIN_LENGTH = 16;
const MAX_TONE_AGENT_NAME_LENGTH = 80;
const MAX_TONE_AGENT_INSTANCE_ID_LENGTH = 120;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneBoard(board: ToneAgentBoardState): ToneAgentBoardState {
  return {
    ...board,
    chain: board.chain.map((item) => ({ ...item })),
    values: Object.fromEntries(Object.entries(board.values).map(([id, values]) => [id, { ...values }])),
    bypassed: [...board.bypassed],
    source: { ...board.source },
    routing: { ...board.routing },
    amp: { ...board.amp, ampValues: { ...board.amp.ampValues }, cabValues: { ...board.amp.cabValues } },
  };
}

function isKnobValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validateEffectValues(specId: string, values: unknown, complete = false) {
  if (!isRecord(values)) throw new Error(`效果器参数不合法：${specId}`);
  const controls = getEffectSpec(specId).controls;
  const allowed = new Set(controls.map((control) => control.id));
  const entries = Object.entries(values);
  if (complete && entries.length !== controls.length) throw new Error(`效果器参数不完整：${specId}`);
  for (const [controlId, value] of entries) {
    if (!allowed.has(controlId)) throw new Error(`未知旋钮：${specId}.${controlId}`);
    if (!isKnobValue(value)) throw new Error(`旋钮值超出范围：${specId}.${controlId}`);
  }
}

function validateSource(source: unknown): asserts source is SourceConfig {
  if (!isRecord(source) || typeof source.guitar !== 'string' || typeof source.performance !== 'string' || typeof source.progression !== 'string') {
    throw new Error('清音输入不在可用目录中。');
  }
  if (!guitarIds.has(source.guitar as SourceConfig['guitar']) || !performanceIds.has(source.performance as SourceConfig['performance']) || !progressionIds.has(source.progression as SourceConfig['progression'])) {
    throw new Error('清音输入不在可用目录中。');
  }
}

function validateRouting(routing: unknown): asserts routing is RoutingConfig {
  if (!isRecord(routing) || (routing.mode !== 'serial' && routing.mode !== 'parallel') || !isKnobValue(routing.blend) || !isKnobValue(routing.spread)) {
    throw new Error('路由参数不合法。');
  }
}

function validateAmp(amp: unknown, complete = false): asserts amp is AmpCabConfig {
  if (!isRecord(amp) || typeof amp.ampId !== 'string' || typeof amp.cabId !== 'string' || typeof amp.bypassed !== 'boolean') {
    throw new Error('箱头或箱体状态不合法。');
  }
  if (!ampIds.has(amp.ampId) || !cabIds.has(amp.cabId) || !isRecord(amp.ampValues) || !isRecord(amp.cabValues)) {
    throw new Error('箱头或箱体不在可用目录中。');
  }
  const ampControls = getAmpSpec(amp.ampId).controls;
  const cabControls = getCabSpec(amp.cabId).controls;
  const allowedAmpControls = new Set(ampControls.map((control) => control.id));
  const allowedCabControls = new Set(cabControls.map((control) => control.id));
  const ampEntries = Object.entries(amp.ampValues);
  const cabEntries = Object.entries(amp.cabValues);
  if (complete && (ampEntries.length !== ampControls.length || cabEntries.length !== cabControls.length)) {
    throw new Error('箱头或箱体参数不完整。');
  }
  for (const [id, value] of ampEntries) if (!allowedAmpControls.has(id) || !isKnobValue(value)) throw new Error(`箱头参数不合法：${id}`);
  for (const [id, value] of cabEntries) if (!allowedCabControls.has(id) || !isKnobValue(value)) throw new Error(`箱体参数不合法：${id}`);
}

function assertValidToneAgentBoardState(value: unknown): asserts value is ToneAgentBoardState {
  if (!isRecord(value)) throw new Error('当前板面状态不合法。');
  if (typeof value.name !== 'string' || value.name.length > MAX_TONE_AGENT_NAME_LENGTH) throw new Error('当前音色名称不合法。');
  if (!Array.isArray(value.chain) || value.chain.length > MAX_TONE_AGENT_CHAIN_LENGTH || !isRecord(value.values) || !Array.isArray(value.bypassed)) {
    throw new Error('当前效果器链状态不合法。');
  }

  const instanceIds = new Set<string>();
  for (const item of value.chain) {
    if (!isRecord(item) || typeof item.instanceId !== 'string' || typeof item.specId !== 'string') throw new Error('效果器实例不合法。');
    if (!item.instanceId || item.instanceId.length > MAX_TONE_AGENT_INSTANCE_ID_LENGTH || instanceIds.has(item.instanceId)) throw new Error(`效果器实例 ID 不合法：${item.instanceId}`);
    if (!effectIds.has(item.specId) || (item.lane !== 'A' && item.lane !== 'B')) throw new Error(`未知效果器或声道：${item.specId}`);
    validateEffectValues(item.specId, value.values[item.instanceId], true);
    instanceIds.add(item.instanceId);
  }

  if (Object.keys(value.values).some((instanceId) => !instanceIds.has(instanceId))) throw new Error('当前板面包含孤立的效果器参数。');
  const bypassed = new Set<string>();
  for (const instanceId of value.bypassed) {
    if (typeof instanceId !== 'string' || !instanceIds.has(instanceId) || bypassed.has(instanceId)) throw new Error(`旁通状态不合法：${String(instanceId)}`);
    bypassed.add(instanceId);
  }
  if (value.selectedInstanceId !== undefined && value.selectedInstanceId !== '' && (typeof value.selectedInstanceId !== 'string' || !instanceIds.has(value.selectedInstanceId))) {
    throw new Error('当前选中的效果器不在链路中。');
  }

  validateSource(value.source);
  validateRouting(value.routing);
  validateAmp(value.amp, true);
  if (!isKnobValue(value.output)) throw new Error('输出参数超出范围。');
  if (value.monitorMode !== 'dry' && value.monitorMode !== 'wet') throw new Error('监听模式不合法。');
}

export function validateToneAgentBoardState(value: unknown) {
  try {
    assertValidToneAgentBoardState(value);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : '当前板面状态不合法。'];
  }
}

function validatePreset(preset: unknown): asserts preset is FactoryPreset {
  if (!isRecord(preset) || !Array.isArray(preset.chain) || preset.chain.length < 1 || preset.chain.length > MAX_TONE_AGENT_CHAIN_LENGTH) {
    throw new Error('效果器链长度必须在 1 到 16 块之间。');
  }
  validateSource(preset.source);
  validateRouting(preset.routing);
  validateAmp(preset.amp);
  if (!isKnobValue(preset.output)) throw new Error('输出参数超出范围。');
  preset.chain.forEach((item) => {
    if (!isRecord(item) || typeof item.specId !== 'string' || !effectIds.has(item.specId)) throw new Error(`未知效果器：${isRecord(item) ? String(item.specId) : ''}`);
    if (item.lane !== undefined && item.lane !== 'A' && item.lane !== 'B') throw new Error('效果器声道不合法。');
    validateEffectValues(item.specId, item.settings ?? {});
  });
}

export function applyToneAgentActions(board: ToneAgentBoardState, actions: ToneAgentAction[]) {
  const boardErrors = validateToneAgentBoardState(board);
  if (boardErrors.length > 0) return { board, changed: 0, errors: boardErrors };
  if (!Array.isArray(actions)) return { board: cloneBoard(board), changed: 0, errors: ['Agent 操作列表不合法。'] };
  if (actions.length > MAX_TONE_AGENT_ACTIONS) {
    return { board: cloneBoard(board), changed: 0, errors: [`一次请求最多执行 ${MAX_TONE_AGENT_ACTIONS} 个站内工具操作。`] };
  }

  const original = cloneBoard(board);
  let next = cloneBoard(board);
  let changed = 0;
  try {
    for (const action of actions) {
      if (!isRecord(action) || typeof action.type !== 'string') throw new Error('Agent 操作不合法。');
      if (action.type === 'replace_board') {
        if (typeof action.name !== 'string') throw new Error('音色名称不合法。');
        validatePreset(action.preset);
        const instantiated = instantiatePreset(action.preset);
        next = {
          name: action.name.trim().slice(0, 48) || 'Agent 已调整',
          selectedInstanceId: instantiated.chain[0]?.instanceId,
          chain: instantiated.chain.map((item) => ({ ...item, lane: item.lane ?? 'A' })),
          values: instantiated.values,
          bypassed: instantiated.bypassed,
          source: instantiated.source,
          routing: instantiated.routing,
          amp: instantiated.amp,
          output: instantiated.output,
          monitorMode: 'wet',
        };
      } else if (action.type === 'update_effect') {
        if (typeof action.instanceId !== 'string') throw new Error('效果器实例 ID 不合法。');
        const item = next.chain.find((entry) => entry.instanceId === action.instanceId);
        if (!item) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        validateEffectValues(item.specId, action.values);
        next.values[item.instanceId] = { ...next.values[item.instanceId], ...action.values };
      } else if (action.type === 'add_effect') {
        if (next.chain.length >= MAX_TONE_AGENT_CHAIN_LENGTH) throw new Error('当前板面最多放 16 块效果器。');
        if (typeof action.instanceId !== 'string' || !action.instanceId || action.instanceId.length > MAX_TONE_AGENT_INSTANCE_ID_LENGTH) throw new Error('效果器实例 ID 不合法。');
        if (typeof action.specId !== 'string' || !effectIds.has(action.specId)) throw new Error(`未知效果器：${String(action.specId)}`);
        if (action.lane !== 'A' && action.lane !== 'B') throw new Error('效果器声道不合法。');
        if (!Number.isFinite(action.position)) throw new Error('效果器位置不合法。');
        if (next.chain.some((entry) => entry.instanceId === action.instanceId)) throw new Error(`效果器实例已存在：${action.instanceId}`);
        validateEffectValues(action.specId, action.values ?? {});
        const position = Math.max(0, Math.min(next.chain.length, Math.round(action.position)));
        next.chain.splice(position, 0, { instanceId: action.instanceId, specId: action.specId, lane: action.lane });
        next.values[action.instanceId] = { ...makeDefaultValues(action.specId), ...action.values };
      } else if (action.type === 'remove_effect') {
        if (typeof action.instanceId !== 'string') throw new Error('效果器实例 ID 不合法。');
        const index = next.chain.findIndex((entry) => entry.instanceId === action.instanceId);
        if (index < 0) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        next.chain.splice(index, 1);
        delete next.values[action.instanceId];
        next.bypassed = next.bypassed.filter((id) => id !== action.instanceId);
        if (next.selectedInstanceId === action.instanceId) next.selectedInstanceId = next.chain[Math.min(index, next.chain.length - 1)]?.instanceId;
      } else if (action.type === 'move_effect') {
        if (typeof action.instanceId !== 'string' || !Number.isFinite(action.position)) throw new Error('效果器移动参数不合法。');
        if (action.lane !== undefined && action.lane !== 'A' && action.lane !== 'B') throw new Error('效果器声道不合法。');
        const index = next.chain.findIndex((entry) => entry.instanceId === action.instanceId);
        if (index < 0) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        const [item] = next.chain.splice(index, 1);
        if (action.lane) item.lane = action.lane;
        const position = Math.max(0, Math.min(next.chain.length, Math.round(action.position)));
        next.chain.splice(position, 0, item);
      } else if (action.type === 'set_bypass') {
        if (typeof action.instanceId !== 'string' || typeof action.bypassed !== 'boolean') throw new Error('旁通操作不合法。');
        if (!next.chain.some((entry) => entry.instanceId === action.instanceId)) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        const bypassed = new Set(next.bypassed);
        if (action.bypassed) bypassed.add(action.instanceId);
        else bypassed.delete(action.instanceId);
        next.bypassed = [...bypassed];
      } else if (action.type === 'set_routing') {
        validateRouting(action.routing);
        next.routing = { ...action.routing };
        if (action.routing.mode === 'serial') next.chain = next.chain.map((item) => ({ ...item, lane: 'A' }));
      } else if (action.type === 'set_amp_cab') {
        const amp = isRecord(action.amp) && action.amp.bypassed === undefined
          ? { ...action.amp, bypassed: next.amp.bypassed }
          : action.amp;
        validateAmp(amp, true);
        next.amp = { ...amp, ampValues: { ...amp.ampValues }, cabValues: { ...amp.cabValues } };
      } else if (action.type === 'set_source') {
        validateSource(action.source);
        next.source = { ...action.source };
      } else if (action.type === 'set_output') {
        if (!isKnobValue(action.value)) throw new Error('输出参数超出范围。');
        next.output = action.value;
      } else if (action.type === 'set_monitor') {
        if (action.mode !== 'dry' && action.mode !== 'wet') throw new Error('监听模式不合法。');
        next.monitorMode = action.mode;
      } else {
        throw new Error('未知 Agent 操作。');
      }
      if (action.type !== 'replace_board') next.name = 'Agent 已调整';
      assertValidToneAgentBoardState(next);
      changed += 1;
    }
  } catch (error) {
    return { board: original, changed: 0, errors: [error instanceof Error ? error.message : '无法应用 Agent 操作。'] };
  }
  return { board: next, changed, errors: [] };
}

function effectTeaching(specId: string, values: Record<string, number>) {
  const spec = getEffectSpec(specId);
  return {
    id: spec.id,
    name: spec.name,
    maker: spec.maker,
    category: spec.category,
    family: spec.family,
    description: spec.description,
    fidelity: getEffectFidelity(spec.id),
    values: { ...values },
    controls: spec.controls.map((control) => {
      const lesson = getControlHelp('effect', spec.id, control);
      return { id: control.id, label: control.label, value: values[control.id], range: lesson.range, help: `${lesson.summary} ${lesson.tip}` };
    }),
  };
}

export function createToneAgentToolRuntime(context: ToneAgentBoardState) {
  assertValidToneAgentBoardState(context);
  const projected = cloneBoard(context);
  const actions: ToneAgentAction[] = [];
  let inspected = false;

  const acceptAction = (action: ToneAgentAction, message = '已加入待应用操作。') => {
    if (!inspected) throw new Error('请先调用 inspect_board 读取当前音色，再进行调整。');
    if (actions.length >= MAX_TONE_AGENT_ACTIONS) throw new Error(`一次请求最多执行 ${MAX_TONE_AGENT_ACTIONS} 个站内工具操作。`);
    const acceptedAction = structuredClone(action);
    const preview = applyToneAgentActions(projected, [acceptedAction]);
    if (preview.errors.length > 0) throw new Error(preview.errors[0]);
    Object.assign(projected, preview.board);
    actions.push(acceptedAction);
    return {
      ok: true,
      message,
      ...(acceptedAction.type === 'add_effect' ? { instanceId: acceptedAction.instanceId } : {}),
      ...(acceptedAction.type === 'replace_board' ? { selectedInstanceId: projected.selectedInstanceId } : {}),
    };
  };

  return {
    actions,
    inspectBoard() {
      inspected = true;
      return {
        summary: `${projected.chain.length} 块效果器 · ${projected.routing.mode === 'parallel' ? '双路并联' : '串联'} · ${projected.monitorMode === 'wet' ? '效果声' : '干声'}监听`,
        name: projected.name,
        selectedInstanceId: projected.selectedInstanceId,
        chain: projected.chain.map((item, index) => ({
          order: index + 1,
          instanceId: item.instanceId,
          specId: item.specId,
          name: getEffectSpec(item.specId).name,
          lane: item.lane,
          bypassed: projected.bypassed.includes(item.instanceId),
          values: { ...projected.values[item.instanceId] },
        })),
        source: { ...projected.source, guitarName: getGuitarVoice(projected.source.guitar).name, performanceName: getPerformanceSpec(projected.source.performance).name, progressionName: getChordProgression(projected.source.progression).name },
        routing: { ...projected.routing },
        amp: { id: projected.amp.ampId, name: getAmpSpec(projected.amp.ampId).name, values: { ...projected.amp.ampValues }, bypassed: projected.amp.bypassed },
        cabinet: { id: projected.amp.cabId, name: getCabSpec(projected.amp.cabId).name, values: { ...projected.amp.cabValues }, bypassed: projected.amp.bypassed },
        output: projected.output,
        monitorMode: projected.monitorMode,
      };
    },
    inspectEffect(instanceId: string) {
      const item = projected.chain.find((entry) => entry.instanceId === instanceId);
      return item ? { instanceId, lane: item.lane, bypassed: projected.bypassed.includes(instanceId), ...effectTeaching(item.specId, projected.values[instanceId]) } : null;
    },
    searchEffects(query = '', category?: EffectCategory) {
      const boundedQuery = typeof query === 'string' ? query.toLowerCase().slice(0, 120) : '';
      const tokens = boundedQuery.split(/\s+/).filter(Boolean);
      return EFFECT_SPECS.filter((spec) => {
        if (category && spec.category !== category) return false;
        const haystack = getEffectSearchText(spec).toLowerCase();
        return tokens.length === 0 || tokens.some((token) => haystack.includes(token));
      }).slice(0, 8).map((spec) => ({
        id: spec.id,
        name: spec.name,
        category: spec.category,
        family: spec.family,
        description: spec.description,
        fidelity: getEffectFidelity(spec.id),
        controls: spec.controls.map((control) => ({ id: control.id, label: control.label, defaultValue: control.defaultValue })),
      }));
    },
    updateEffect(instanceId: string, values: Record<string, number>) {
      if (!inspected) throw new Error('请先调用 inspect_board 读取当前音色，再进行调整。');
      const item = projected.chain.find((entry) => entry.instanceId === instanceId);
      if (!item) throw new Error(`当前链路中没有效果器：${instanceId}`);
      validateEffectValues(item.specId, values);
      return acceptAction(
        { type: 'update_effect', instanceId, values: { ...values } },
        `已准备调整 ${getEffectSpec(item.specId).name} 的 ${Object.keys(values).join(' / ')}`,
      );
    },
    record(action: ToneAgentAction) {
      return acceptAction(action);
    },
    makeAmpCab(ampId: string, cabId: string, ampValues: Record<string, number> = {}, cabValues: Record<string, number> = {}, bypassed = projected.amp.bypassed) {
      return { ...makeAmpCabConfig(ampId, cabId, ampValues, cabValues), bypassed };
    },
  };
}

export function captureToneAgentBoard(board: ToneAgentBoardState): ToneAgentBoardState {
  return cloneBoard(board);
}
