import { AMP_SPECS, CAB_SPECS, makeAmpCabConfig } from '../amps/catalog.ts';
import { CHORD_PROGRESSIONS, GUITAR_VOICES, PERFORMANCE_SPECS, type SourceConfig } from '../audio/source-catalog.ts';
import { EFFECT_SPECS, type PresetChainItem } from '../effects/catalog.ts';
import { getEffectFidelity } from '../effects/fidelity.ts';
import type { ToneAgentPlan } from './tone-agent.ts';

type UnknownRecord = Record<string, unknown>;

export const MAX_TONE_AGENT_REQUEST_BYTES = 128 * 1024;
export const MAX_TONE_AGENT_CONTEXT_BYTES = 32 * 1024;
export const MAX_TONE_AGENT_HISTORY_MESSAGES = 12;
export const MAX_TONE_AGENT_HISTORY_MESSAGE_LENGTH = 2_000;
export const MAX_TONE_AGENT_HISTORY_BYTES = 24 * 1024;
export const MAX_TONE_AGENT_PLAN_BYTES = 64 * 1024;

const effectsById = new Map(EFFECT_SPECS.map((effect) => [effect.id, effect]));
const ampsById = new Map(AMP_SPECS.map((amp) => [amp.id, amp]));
const cabsById = new Map(CAB_SPECS.map((cab) => [cab.id, cab]));
const guitars: ReadonlySet<string> = new Set(GUITAR_VOICES.map((entry) => entry.id));
const performances: ReadonlySet<string> = new Set(PERFORMANCE_SPECS.map((entry) => entry.id));
const progressions: ReadonlySet<string> = new Set(CHORD_PROGRESSIONS.map((entry) => entry.id));

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, fallback: string, maxLength: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function boundedNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function serializedByteLength(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeValues(value: unknown, allowed: Set<string>) {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > allowed.size) return null;
  const result: Record<string, number> = {};
  for (const [key, entry] of entries) {
    const number = boundedNumber(entry);
    if (!allowed.has(key) || number === null) return null;
    result[key] = number;
  }
  return result;
}

function boundedProviderText(value: string) {
  const text = value.trim();
  return text && serializedByteLength(text) <= MAX_TONE_AGENT_PLAN_BYTES ? text : null;
}

export function buildToneAgentInput(request: string) {
  const catalog = {
    effects: EFFECT_SPECS.map((effect) => ({
      id: effect.id,
      name: effect.name,
      category: effect.category,
      modeling: getEffectFidelity(effect.id) ?? {
        engine: 'Legacy Web Audio approximation',
        runtime: 'legacy-web-audio',
        status: 'unverified',
        targetScore: null,
        verifiedScore: null,
      },
      controls: effect.controls.map((control) => control.id),
    })),
    amps: AMP_SPECS.map((amp) => ({ id: amp.id, name: amp.name, modeling: amp.modeling, controls: amp.controls.map((control) => control.id) })),
    cabinets: CAB_SPECS.map((cab) => ({ id: cab.id, name: cab.name, modeling: cab.modeling, controls: cab.controls.map((control) => control.id) })),
    sources: {
      guitars: GUITAR_VOICES.map((entry) => entry.id),
      performances: PERFORMANCE_SPECS.map((entry) => entry.id),
      progressions: CHORD_PROGRESSIONS.map((entry) => entry.id),
    },
  };

  return [
    '你是 Sonic Board 的 gpt-5.6-terra 音色 Agent。根据用户需求生成一条可直接试听的盯鞋吉他效果器链。',
    '只输出 JSON，不要 Markdown、解释或代码围栏。只能使用目录中的 id。链长 3 到 8 块；所有旋钮、输出、平衡和宽度都使用 0 到 100。',
    '串联时省略 lane；并联时每块 lane 只能是 A 或 B。合理选择清音吉他、演奏方式、和弦进行、箱头和箱体。',
    '返回结构：{"name":"","summary":"","decisions":[""],"source":{"guitar":"","performance":"","progression":""},"routing":{"mode":"serial|parallel","blend":50,"spread":0},"amp":{"ampId":"","cabId":"","ampValues":{},"cabValues":{},"bypassed":false},"output":65,"chain":[{"specId":"","lane":"A","settings":{}}]}',
    `可用目录：${JSON.stringify(catalog)}`,
    `用户需求：${(typeof request === 'string' ? request.trim().slice(0, 240) : '') || '做一条均衡、日常可用的反向音墙。'}`,
  ].join('\n');
}

export function parseResponsesText(payload: unknown) {
  if (!isRecord(payload)) return null;
  if (typeof payload.output_text === 'string') return boundedProviderText(payload.output_text);
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === 'string') {
        const text = boundedProviderText(content.text);
        if (text) return text;
      }
    }
  }
  return null;
}

export function parseToneAgentJson(text: string) {
  if (typeof text !== 'string') return null;
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (serializedByteLength(clean) > MAX_TONE_AGENT_PLAN_BYTES) return null;
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return null;
  }
}

export function normalizeRemoteTonePlan(value: unknown): ToneAgentPlan | null {
  if (serializedByteLength(value) > MAX_TONE_AGENT_PLAN_BYTES) return null;
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.routing) || !isRecord(value.amp) || !Array.isArray(value.chain)) return null;
  if (value.chain.length < 3 || value.chain.length > 8) return null;

  const source = value.source;
  if (
    typeof source.guitar !== 'string' ||
    typeof source.performance !== 'string' ||
    typeof source.progression !== 'string' ||
    !guitars.has(source.guitar) ||
    !performances.has(source.performance) ||
    !progressions.has(source.progression)
  ) return null;
  const sourceConfig: SourceConfig = {
    guitar: source.guitar as SourceConfig['guitar'],
    performance: source.performance as SourceConfig['performance'],
    progression: source.progression as SourceConfig['progression'],
  };

  const routing = value.routing;
  if (routing.mode !== 'serial' && routing.mode !== 'parallel') return null;
  const blend = boundedNumber(routing.blend);
  const spread = boundedNumber(routing.spread);
  if (blend === null || spread === null) return null;

  const amp = value.amp;
  if (typeof amp.ampId !== 'string' || typeof amp.cabId !== 'string') return null;
  if (amp.bypassed !== undefined && typeof amp.bypassed !== 'boolean') return null;
  const ampSpec = ampsById.get(amp.ampId);
  const cabSpec = cabsById.get(amp.cabId);
  if (!ampSpec || !cabSpec) return null;
  const ampValues = normalizeValues(amp.ampValues, new Set(ampSpec.controls.map((control) => control.id)));
  const cabValues = normalizeValues(amp.cabValues, new Set(cabSpec.controls.map((control) => control.id)));
  if (!ampValues || !cabValues) return null;

  const chain: PresetChainItem[] = [];
  for (const rawItem of value.chain) {
    if (!isRecord(rawItem) || typeof rawItem.specId !== 'string') return null;
    const spec = effectsById.get(rawItem.specId);
    if (!spec) return null;
    const settings = normalizeValues(rawItem.settings, new Set(spec.controls.map((control) => control.id)));
    if (!settings) return null;
    const lane = rawItem.lane;
    if (routing.mode === 'parallel' && lane !== 'A' && lane !== 'B') return null;
    if (routing.mode === 'serial' && lane !== undefined && lane !== 'A' && lane !== 'B') return null;
    chain.push({ specId: spec.id, lane: routing.mode === 'parallel' ? lane as 'A' | 'B' : undefined, settings });
  }

  const output = boundedNumber(value.output);
  if (output === null) return null;
  const decisions = Array.isArray(value.decisions)
    ? value.decisions.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).slice(0, 6).map((entry) => entry.trim().slice(0, 100))
    : [];
  if (decisions.length === 0) return null;

  const name = boundedText(value.name, 'Agent 音色', 40);
  const summary = boundedText(value.summary, '根据需求生成并校验的效果器链。', 160);
  const ampConfig = makeAmpCabConfig(ampSpec.id, cabSpec.id, ampValues, cabValues);
  ampConfig.bypassed = amp.bypassed === undefined ? false : amp.bypassed;
  return {
    name,
    summary,
    decisions,
    preset: {
      id: 'agent-remote',
      name,
      description: summary,
      source: sourceConfig,
      output,
      routing: { mode: routing.mode, blend, spread },
      amp: ampConfig,
      chain,
    },
  };
}
