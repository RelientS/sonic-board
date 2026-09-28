import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_TONE_AGENT_REQUEST_BYTES } from '../agent/tone-agent-api.ts';
import { createToneAgentPost, mapToneAgentError } from '../api/tone-agent/route.ts';
import type { ToneAgentBoardState, ToneAgentPlan, ToneAgentRequest } from '../agent/tone-agent-runtime.ts';
import { makeAmpCabConfig } from '../amps/catalog.ts';

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

const requestBody = { instruction: '读取当前音色', context, history: [] } satisfies ToneAgentRequest;
const plan: ToneAgentPlan = { message: 'ok', actions: [], provider: 'pi', trace: [] };

async function withServerKey<T>(operation: () => Promise<T>) {
  const previous = process.env.TOKEN_SHARE_KEY;
  process.env.TOKEN_SHARE_KEY = 'test-server-key';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.TOKEN_SHARE_KEY;
    else process.env.TOKEN_SHARE_KEY = previous;
  }
}

function request(body: string | object = requestBody, init: RequestInit = {}) {
  return new Request('http://localhost/api/tone-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

test('tone agent route keeps credentials server-side and streams the Pi agent', () => {
  assert.equal(typeof createToneAgentPost, 'function');
  assert.equal(typeof mapToneAgentError, 'function');
});

test('pre-aborted requests do not invoke the upstream runner', async () => {
  await withServerKey(async () => {
    let calls = 0;
    const post = createToneAgentPost({
      runToneAgent: async () => {
        calls += 1;
        return plan;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const response = await post(request(requestBody, { signal: controller.signal }));

    assert.equal(response.status, 499);
    assert.equal(calls, 0);
  });
});

test('malformed and oversized request bodies are rejected before upstream work', async () => {
  await withServerKey(async () => {
    let calls = 0;
    const post = createToneAgentPost({
      runToneAgent: async () => {
        calls += 1;
        return plan;
      },
    });

    const malformed = await post(request('{"instruction":'));
    assert.equal(malformed.status, 400);

    const oversized = await post(request('x'.repeat(MAX_TONE_AGENT_REQUEST_BYTES + 1)));
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
  });
});

test('cancelled SSE responses abort the runner and stop heartbeats', async () => {
  await withServerKey(async () => {
    let startedResolve: (() => void) | undefined;
    let abortedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const aborted = new Promise<void>((resolve) => { abortedResolve = resolve; });
    const post = createToneAgentPost({
      heartbeatIntervalMs: 5,
      runToneAgent: async (_key, _input, options) => {
        startedResolve?.();
        options?.signal?.addEventListener('abort', () => abortedResolve?.(), { once: true });
        await aborted;
        throw new DOMException('Aborted', 'AbortError');
      },
    });

    const response = await post(request());
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ': connected\n\n');
    await started;
    await reader.cancel();
    await aborted;
  });
});

test('upstream details are mapped to a safe SSE error with a correlation id', async () => {
  await withServerKey(async () => {
    const post = createToneAgentPost({
      runToneAgent: async () => {
        throw Object.assign(new Error('upstream internal test detail'), { status: 401 });
      },
    });
    const response = await post(request());
    const text = await response.text();

    assert.match(text, /请求 ID/);
    assert.doesNotMatch(text, /upstream internal test detail/);
    assert.equal(mapToneAgentError(Object.assign(new Error('secret'), { status: 429 })), '音色 Agent 暂时繁忙，请稍后重试。');
  });
});
