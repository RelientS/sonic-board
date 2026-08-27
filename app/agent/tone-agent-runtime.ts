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
import { EFFECT_SPECS, getEffectSpec, instantiatePreset, makeDefaultValues, type EffectCategory, type FactoryPreset } from '../effects/catalog.ts';
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

function validateEffectValues(specId: string, values: Record<string, number>) {
  const allowed = new Set(getEffectSpec(specId).controls.map((control) => control.id));
  for (const [controlId, value] of Object.entries(values)) {
    if (!allowed.has(controlId)) throw new Error(`未知旋钮：${specId}.${controlId}`);
    if (!isKnobValue(value)) throw new Error(`旋钮值超出范围：${specId}.${controlId}`);
  }
}

function validateSource(source: SourceConfig) {
  if (!guitarIds.has(source.guitar) || !performanceIds.has(source.performance) || !progressionIds.has(source.progression)) {
    throw new Error('清音输入不在可用目录中。');
  }
}

function validateRouting(routing: RoutingConfig) {
  if ((routing.mode !== 'serial' && routing.mode !== 'parallel') || !isKnobValue(routing.blend) || !isKnobValue(routing.spread)) {
    throw new Error('路由参数不合法。');
  }
}

function validateAmp(amp: AmpCabConfig) {
  if (!ampIds.has(amp.ampId) || !cabIds.has(amp.cabId)) throw new Error('箱头或箱体不在可用目录中。');
  const ampControls = new Set(getAmpSpec(amp.ampId).controls.map((control) => control.id));
  const cabControls = new Set(getCabSpec(amp.cabId).controls.map((control) => control.id));
  for (const [id, value] of Object.entries(amp.ampValues)) if (!ampControls.has(id) || !isKnobValue(value)) throw new Error(`箱头参数不合法：${id}`);
  for (const [id, value] of Object.entries(amp.cabValues)) if (!cabControls.has(id) || !isKnobValue(value)) throw new Error(`箱体参数不合法：${id}`);
}

function validatePreset(preset: FactoryPreset) {
  if (preset.chain.length < 1 || preset.chain.length > 16) throw new Error('效果器链长度必须在 1 到 16 块之间。');
  validateSource(preset.source as SourceConfig);
  validateRouting(preset.routing);
  validateAmp(preset.amp);
  if (!isKnobValue(preset.output)) throw new Error('输出参数超出范围。');
  preset.chain.forEach((item) => {
    if (!effectIds.has(item.specId)) throw new Error(`未知效果器：${item.specId}`);
    if (item.lane !== undefined && item.lane !== 'A' && item.lane !== 'B') throw new Error('效果器声道不合法。');
    validateEffectValues(item.specId, item.settings ?? {});
  });
}

export function applyToneAgentActions(board: ToneAgentBoardState, actions: ToneAgentAction[]) {
  let next = cloneBoard(board);
  const errors: string[] = [];
  let changed = 0;

  for (const action of actions.slice(0, 16)) {
    try {
      if (action.type === 'replace_board') {
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
        const item = next.chain.find((entry) => entry.instanceId === action.instanceId);
        if (!item) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        validateEffectValues(item.specId, action.values);
        next.values[item.instanceId] = { ...next.values[item.instanceId], ...action.values };
      } else if (action.type === 'add_effect') {
        if (next.chain.length >= 16) throw new Error('当前板面最多放 16 块效果器。');
        if (!effectIds.has(action.specId)) throw new Error(`未知效果器：${action.specId}`);
        if (next.chain.some((entry) => entry.instanceId === action.instanceId)) throw new Error(`效果器实例已存在：${action.instanceId}`);
        validateEffectValues(action.specId, action.values ?? {});
        const position = Math.max(0, Math.min(next.chain.length, Math.round(action.position)));
        next.chain.splice(position, 0, { instanceId: action.instanceId, specId: action.specId, lane: action.lane });
        next.values[action.instanceId] = { ...makeDefaultValues(action.specId), ...action.values };
      } else if (action.type === 'remove_effect') {
        const index = next.chain.findIndex((entry) => entry.instanceId === action.instanceId);
        if (index < 0) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        next.chain.splice(index, 1);
        delete next.values[action.instanceId];
        next.bypassed = next.bypassed.filter((id) => id !== action.instanceId);
      } else if (action.type === 'move_effect') {
        const index = next.chain.findIndex((entry) => entry.instanceId === action.instanceId);
        if (index < 0) throw new Error(`当前链路中没有效果器：${action.instanceId}`);
        const [item] = next.chain.splice(index, 1);
        if (action.lane) item.lane = action.lane;
        const position = Math.max(0, Math.min(next.chain.length, Math.round(action.position)));
        next.chain.splice(position, 0, item);
      } else if (action.type === 'set_bypass') {
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
        validateAmp(action.amp);
        next.amp = { ...action.amp, ampValues: { ...action.amp.ampValues }, cabValues: { ...action.amp.cabValues } };
      } else if (action.type === 'set_source') {
        validateSource(action.source);
        next.source = { ...action.source };
      } else if (action.type === 'set_output') {
        if (!isKnobValue(action.value)) throw new Error('输出参数超出范围。');
        next.output = action.value;
      } else if (action.type === 'set_monitor') {
        next.monitorMode = action.mode;
      }
      if (action.type !== 'replace_board') next.name = 'Agent 已调整';
      changed += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '无法应用 Agent 操作。');
    }
  }
  return { board: next, changed, errors };
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
  const actions: ToneAgentAction[] = [];
  return {
    actions,
    inspectBoard() {
      return {
        summary: `${context.chain.length} 块效果器 · ${context.routing.mode === 'parallel' ? '双路并联' : '串联'} · ${context.monitorMode === 'wet' ? '效果声' : '干声'}监听`,
        name: context.name,
        selectedInstanceId: context.selectedInstanceId,
        chain: context.chain.map((item, index) => ({
          order: index + 1,
          instanceId: item.instanceId,
          specId: item.specId,
          name: getEffectSpec(item.specId).name,
          lane: item.lane,
          bypassed: context.bypassed.includes(item.instanceId),
          values: { ...context.values[item.instanceId] },
        })),
        source: { ...context.source, guitarName: getGuitarVoice(context.source.guitar).name, performanceName: getPerformanceSpec(context.source.performance).name, progressionName: getChordProgression(context.source.progression).name },
        routing: context.routing,
        amp: { id: context.amp.ampId, name: getAmpSpec(context.amp.ampId).name, values: context.amp.ampValues },
        cabinet: { id: context.amp.cabId, name: getCabSpec(context.amp.cabId).name, values: context.amp.cabValues },
        output: context.output,
      };
    },
    inspectEffect(instanceId: string) {
      const item = context.chain.find((entry) => entry.instanceId === instanceId);
      return item ? { instanceId, lane: item.lane, bypassed: context.bypassed.includes(instanceId), ...effectTeaching(item.specId, context.values[instanceId]) } : null;
    },
    searchEffects(query = '', category?: EffectCategory) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      return EFFECT_SPECS.filter((spec) => {
        if (category && spec.category !== category) return false;
        const haystack = [spec.id, spec.name, spec.maker, spec.family, spec.description, spec.category].join(' ').toLowerCase();
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
      const item = context.chain.find((entry) => entry.instanceId === instanceId);
      if (!item) throw new Error(`当前链路中没有效果器：${instanceId}`);
      validateEffectValues(item.specId, values);
      actions.push({ type: 'update_effect', instanceId, values: { ...values } });
      return { ok: true, message: `已准备调整 ${getEffectSpec(item.specId).name} 的 ${Object.keys(values).join(' / ')}` };
    },
    record(action: ToneAgentAction) {
      const preview = applyToneAgentActions(context, [action]);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      if (actions.length >= 16) throw new Error('一次请求最多执行 16 个站内工具操作。');
      actions.push(action);
      return { ok: true, message: '已加入待应用操作。' };
    },
    makeAmpCab(ampId: string, cabId: string, ampValues: Record<string, number> = {}, cabValues: Record<string, number> = {}) {
      return makeAmpCabConfig(ampId, cabId, ampValues, cabValues);
    },
  };
}

export function captureToneAgentBoard(board: ToneAgentBoardState): ToneAgentBoardState {
  return cloneBoard(board);
}
