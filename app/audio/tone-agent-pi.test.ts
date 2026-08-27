import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToneAgentPrompt, createToneAgentTools, normalizeToneAgentRequest } from '../agent/tone-agent-pi.ts';
import { makeAmpCabConfig } from '../amps/catalog.ts';
import type { ToneAgentBoardState, ToneAgentTraceStep } from '../agent/tone-agent-runtime.ts';

const context: ToneAgentBoardState = {
  name: '当前音色',
  chain: [{ instanceId: 'phase-1', specId: 'slow-phase', lane: 'A' }],
  values: { 'phase-1': { rate: 18, depth: 38, res: 18, mix: 44 } },
  bypassed: [],
  source: { guitar: 'single-neck', performance: 'arpeggio', progression: 'dream-open' },
  routing: { mode: 'serial', blend: 50, spread: 0 },
  amp: makeAmpCabConfig('brit-20', 'closed-4x12'),
  output: 63,
  monitorMode: 'wet',
};

test('pi prompt treats history and board summaries as untrusted context', () => {
  const prompt = buildToneAgentPrompt('为什么相位听不明显？', context, [
    { role: 'user', content: '之前把 rate 调慢了' },
    { role: 'assistant', content: '已经调到 18' },
  ]);

  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /为什么相位听不明显/);
  assert.match(prompt, /之前把 rate 调慢了/);
  assert.match(prompt, /经典名称只用于标识参考对象/);
  assert.match(prompt, /Dyna Comp.*RAT 2.*PedalKernel WDF/s);
  assert.match(prompt, /BD-2.*Big Muff.*旧引擎/s);
  assert.match(prompt, /没有真机盲测分数/);
  assert.doesNotMatch(prompt, /sk-token/);
});

test('pi request normalization rejects forged catalog state and bounds conversation history', () => {
  const valid = normalizeToneAgentRequest({
    instruction: '读取当前音色',
    context,
    history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `第 ${index} 条` })),
  });
  assert.ok(valid);
  assert.equal(valid.history.length, 12);

  assert.equal(normalizeToneAgentRequest({
    instruction: '读取',
    context: { ...context, chain: [{ instanceId: 'x', specId: 'unknown', lane: 'A' }] },
    history: [],
  }), null);
  assert.equal(normalizeToneAgentRequest({
    instruction: '读取',
    context: { ...context, values: { 'phase-1': { ...context.values['phase-1'], imaginary: 999 } } },
    history: [],
  }), null);
  assert.equal(normalizeToneAgentRequest({ instruction: '读取', context: { ...context, output: -2 }, history: [] }), null);
  const longChain = Array.from({ length: 16 }, (_, index) => ({ instanceId: `phase-${index}`, specId: 'slow-phase', lane: 'A' as const }));
  const longValues = Object.fromEntries(longChain.map((item) => [item.instanceId, { rate: 18, depth: 38, res: 18, mix: 44 }]));
  assert.equal(normalizeToneAgentRequest({
    instruction: '读取',
    context: { ...context, chain: longChain, values: longValues, output: 101 },
    history: [],
  }), null);
});

test('pi toolset covers observation, teaching, chain edits, source, routing, amp and output', () => {
  const traces: ToneAgentTraceStep[] = [];
  const runtime = createToneAgentTools(context, (step) => traces.push(step));
  const names = runtime.tools.map((tool) => tool.name);

  assert.deepEqual(names, [
    'inspect_board', 'inspect_effect', 'search_effects', 'replace_board',
    'update_effect', 'add_effect', 'remove_effect', 'move_effect', 'set_effect_bypass',
    'set_routing', 'set_amp_cab', 'set_input_source', 'set_output', 'set_monitor',
  ]);
  assert.equal(runtime.actions.length, 0);
});

test('pi tools emit visible call/result traces and validated actions', async () => {
  const traces: ToneAgentTraceStep[] = [];
  const runtime = createToneAgentTools(context, (step) => traces.push(step));
  const inspect = runtime.tools.find((tool) => tool.name === 'inspect_board');
  const update = runtime.tools.find((tool) => tool.name === 'update_effect');
  assert.ok(inspect && update);

  await inspect.execute('call-1', {} as never, undefined as never, undefined as never);
  await update.execute('call-2', { instanceId: 'phase-1', values: { rate: 9, mix: 31 } } as never, undefined as never, undefined as never);

  assert.equal(traces.length, 4);
  assert.equal(traces[0].kind, 'observe');
  assert.equal(traces[3].kind, 'tool-result');
  assert.deepEqual(runtime.actions, [{ type: 'update_effect', instanceId: 'phase-1', values: { rate: 9, mix: 31 } }]);
});
