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
  assert.match(prompt, /11.*PedalKernel WDF.*实时修正/s);
  assert.doesNotMatch(prompt, /旧引擎/);
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
  const legacyAmp = {
    ampId: context.amp.ampId,
    cabId: context.amp.cabId,
    ampValues: context.amp.ampValues,
    cabValues: context.amp.cabValues,
  };
  const legacyContext = { ...context, amp: legacyAmp };
  assert.ok(normalizeToneAgentRequest({ instruction: '读取', context: legacyContext, history: [] }));
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

test('pi tools enforce inspect-first and project accepted actions into later observations', async () => {
  const runtime = createToneAgentTools(context);
  const inspect = runtime.tools.find((tool) => tool.name === 'inspect_board');
  const update = runtime.tools.find((tool) => tool.name === 'update_effect');
  assert.ok(inspect && update);

  await assert.rejects(
    update.execute('call-before-inspect', { instanceId: 'phase-1', values: { rate: 9 } } as never, undefined as never, undefined as never),
    /先调用 inspect_board/,
  );
  await inspect.execute('call-inspect', {} as never, undefined as never, undefined as never);
  await update.execute('call-update', { instanceId: 'phase-1', values: { rate: 9 } } as never, undefined as never, undefined as never);
  const result = await inspect.execute('call-inspect-again', {} as never, undefined as never, undefined as never);
  const text = result.content.find((entry) => entry.type === 'text')?.text;
  assert.ok(text);
  const board = JSON.parse(text);
  assert.equal(board.chain[0].values.rate, 9);
});

test('pi tools cap update actions and preserve amp bypass state', async () => {
  const ampRuntime = createToneAgentTools({ ...context, amp: { ...context.amp, bypassed: true } });
  const ampInspect = ampRuntime.tools.find((tool) => tool.name === 'inspect_board');
  const setAmp = ampRuntime.tools.find((tool) => tool.name === 'set_amp_cab');
  assert.ok(ampInspect && setAmp);

  const initial = await ampInspect.execute('call-inspect', {} as never, undefined as never, undefined as never);
  const initialText = initial.content.find((entry) => entry.type === 'text')?.text;
  assert.ok(initialText);
  assert.equal(JSON.parse(initialText).amp.bypassed, true);
  await setAmp.execute('call-set-amp', { ampId: 'brit-20', cabId: 'closed-4x12' } as never, undefined as never, undefined as never);
  const ampAction = ampRuntime.actions.at(-1);
  assert.equal(ampAction?.type, 'set_amp_cab');
  assert.equal(ampAction?.type === 'set_amp_cab' ? ampAction.amp.bypassed : undefined, true);

  const runtime = createToneAgentTools(context);
  const inspect = runtime.tools.find((tool) => tool.name === 'inspect_board');
  const update = runtime.tools.find((tool) => tool.name === 'update_effect');
  assert.ok(inspect && update);
  await inspect.execute('call-inspect', {} as never, undefined as never, undefined as never);
  for (let index = 0; index < 16; index += 1) {
    await update.execute(`call-update-${index}`, { instanceId: 'phase-1', values: { rate: index } } as never, undefined as never, undefined as never);
  }
  await assert.rejects(
    update.execute('call-update-over-cap', { instanceId: 'phase-1', values: { rate: 20 } } as never, undefined as never, undefined as never),
    /最多执行 16 个/,
  );
});
