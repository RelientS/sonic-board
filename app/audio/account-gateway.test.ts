import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_REQUEST_COST, SIGNUP_CREDITS } from '../account/accounts.ts';
import { classifySseStart, decideAgentAccess, GATEWAY_SECRET_HEADER, watchAgentStream } from '../account/gateway.ts';
import { clientIp, isSameOrigin } from '../account/http.ts';
import { AccountService } from '../account/service.ts';
import { SESSION_COOKIE } from '../account/session.ts';
import { MemoryAccountStore } from '../account/store.ts';
import { makeAmpCabConfig } from '../amps/catalog.ts';
import type { ToneAgentBoardState, ToneAgentRequest } from '../agent/tone-agent-runtime.ts';
import { createToneAgentGateway } from '../api/tone-agent/route.ts';

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
const completeEvent = `data: ${JSON.stringify({ type: 'complete', plan: { message: 'ok', actions: [], provider: 'pi', trace: [] } })}\n\n`;

const base = { authenticated: true, credits: 3, rateRemaining: 5, inFlight: 0, maxInFlight: 4 };

test('gateway decisions: 401 before 402 before 429', () => {
  assert.deepEqual(decideAgentAccess(base), { ok: true });
  assert.equal((decideAgentAccess({ ...base, authenticated: false, credits: 0 }) as { status: number }).status, 401);
  const noCredits = decideAgentAccess({ ...base, credits: 0, rateRemaining: 0 });
  assert.equal(noCredits.ok, false);
  assert.equal((noCredits as { status: number }).status, 402);
  assert.match((noCredits as { error: string }).error, /邀请/);
  assert.equal((decideAgentAccess({ ...base, rateRemaining: 0 }) as { code: string }).code, 'rate_limited');
  assert.equal((decideAgentAccess({ ...base, inFlight: 4 }) as { code: string }).code, 'busy');
  assert.equal((decideAgentAccess({ ...base, inFlight: 4 }) as { status: number }).status, 429);
});

test('SSE start classification ignores comments and flags an initial error event', () => {
  assert.equal(classifySseStart(': connected\n\n'), 'pending');
  assert.equal(classifySseStart(': connected\n\ndata: {"type":"trace"'), 'pending');
  assert.equal(classifySseStart(': connected\n\ndata: {"type":"text_delta","delta":"hi"}\n\n'), 'output');
  assert.equal(classifySseStart('data: {"type":"error","error":"x"}\r\n\r\n'), 'failed');
  assert.equal(classifySseStart('data: {"type":"heartbeat"}\n\ndata: {"type":"error","error":"x"}\n\n'), 'failed');
});

function streamOf(chunks: string[], fail?: Error) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text().catch(() => 'errored');
}

test('watchAgentStream passes bytes through and settles once', async () => {
  const results: string[] = [];
  const onSettle = (result: string) => results.push(result);
  assert.equal(await drain(watchAgentStream(streamOf([': connected\n\n', completeEvent]), { onSettle })), `: connected\n\n${completeEvent}`);
  await drain(watchAgentStream(streamOf([': connected\n\n']), { onSettle }));
  await drain(watchAgentStream(streamOf(['data: {"type":"error","error":"x"}\n\n']), { onSettle }));
  await drain(watchAgentStream(streamOf([': connected\n\n'], new Error('reset')), { onSettle }));
  const aborted = new AbortController();
  aborted.abort();
  await drain(watchAgentStream(streamOf([': connected\n\n']), { onSettle, signal: aborted.signal }));
  const cancelled = watchAgentStream(streamOf([': connected\n\n']), { onSettle });
  await cancelled.cancel();
  assert.deepEqual(results, ['output', 'failed', 'failed', 'failed', 'aborted', 'aborted']);
});

test('client IP prefers Cloudflare, then X-Forwarded-For; origin check blocks cross-site', () => {
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })), '1.2.3.4');
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' })), '5.6.7.8');
  assert.equal(clientIp(new Headers()), 'local');
  const url = 'http://127.0.0.1:3111/api/tone-agent';
  assert.equal(isSameOrigin(new Request(url, { method: 'POST', headers: { origin: 'https://h5.tryx402.xyz' } })), true);
  assert.equal(isSameOrigin(new Request(url, { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } })), true);
  assert.equal(isSameOrigin(new Request(url, { method: 'POST' })), true, 'absent Origin/Referer is allowed');
  assert.equal(isSameOrigin(new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } })), false);
  assert.equal(isSameOrigin(new Request(url, { method: 'POST', headers: { referer: 'https://evil.example/x' } })), false);
  assert.equal(isSameOrigin(new Request(url, { method: 'POST', headers: { origin: 'null' } })), false);
});

async function setup(options: { credits?: number; upstream?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; local?: (request: Request) => Promise<Response> } = {}) {
  const service = new AccountService(new MemoryAccountStore());
  const registered = await service.register({ username: 'tester', password: 'password123', ip: '1.1.1.1' });
  assert.ok(registered.ok);
  const userId = Object.keys((service.store as MemoryAccountStore).state.users)[0];
  if (options.credits !== undefined) {
    await service.store.transact((state) => {
      state.users[userId].balance = options.credits!;
    });
  }
  let seq = 0;
  const handler = createToneAgentGateway({
    service: () => service,
    upstreamUrl: options.upstream ? 'https://upstream.example/api/tone-agent' : '',
    localHandler: options.local ?? (async () => new Response(streamOf([': connected\n\n', completeEvent]), { headers: { 'Content-Type': 'text/event-stream' } })),
    fetch: options.upstream as typeof fetch | undefined,
    gatewaySecret: '',
    requestId: () => `req-${++seq}`,
  });
  const call = (init: { cookie?: boolean; origin?: string; body?: unknown } = {}) => handler(new Request('http://127.0.0.1:3111/api/tone-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init.cookie === false ? {} : { cookie: `${SESSION_COOKIE}=${registered.token}` }),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: JSON.stringify(init.body ?? requestBody),
  }));
  const balance = () => service.store.read((state) => state.users[userId].balance);
  return { service, call, balance, token: registered.token };
}

test('gateway rejects missing session (401), cross-site (403), no credits (402) without charging', async () => {
  const { call, balance } = await setup({ credits: 0 });
  assert.equal((await call({ cookie: false })).status, 401);
  assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
  const denied = await call();
  assert.equal(denied.status, 402);
  const payload = await denied.json() as { code: string; error: string };
  assert.equal(payload.code, 'insufficient_credits');
  assert.match(payload.error, /\+15/);
  assert.equal(await balance(), 0);
  assert.equal((await call({ body: { instruction: 'x' } })).status, 400, 'validation still runs');
});

test('gateway charges one credit per accepted request and rate limits per account (429)', async () => {
  const { call, balance } = await setup();
  for (let index = 0; index < 5; index += 1) {
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    await response.text();
  }
  assert.equal(await balance(), SIGNUP_CREDITS - 5 * AGENT_REQUEST_COST);
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, 'rate_limited');
  assert.equal(await balance(), SIGNUP_CREDITS - 5);
});

test('gateway enforces global concurrency (429 busy)', async () => {
  const pending: Array<() => void> = [];
  const { call, service } = await setup({
    local: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(completeEvent));
        pending.push(() => controller.close());
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  // Fill the gate directly so the per-account rate limit is not the limiting factor.
  const held = Array.from({ length: service.agentGate.max }, () => service.agentGate.tryAcquire());
  const busy = await call();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json() as { code: string }).code, 'busy');
  held.forEach((release) => release?.());
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.equal(service.agentGate.inFlight, 1, 'slot held while streaming');
  pending.forEach((close) => close());
  await ok.text();
  assert.equal(service.agentGate.inFlight, 0, 'slot released when the stream ends');
});

test('gateway forwards to upstream without cookies and refunds when upstream fails before output', async () => {
  const seen: RequestInit[] = [];
  let mode: 'ok' | 'http-error' | 'throw' | 'error-event' = 'ok';
  const { call, balance } = await setup({
    upstream: async (_input, init) => {
      seen.push(init!);
      if (mode === 'throw') throw new TypeError('fetch failed');
      if (mode === 'http-error') return new Response('bad gateway', { status: 502 });
      const body = mode === 'ok' ? [': connected\n\n', completeEvent] : [': connected\n\n', 'data: {"type":"error","error":"x"}\n\n'];
      return new Response(streamOf(body), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const ok = await call();
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), `: connected\n\n${completeEvent}`);
  assert.equal(await balance(), SIGNUP_CREDITS - 1);
  const headers = new Headers(seen[0].headers);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get(GATEWAY_SECRET_HEADER), null);
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.deepEqual(JSON.parse(String(seen[0].body)), JSON.parse(JSON.stringify(requestBody)));

  mode = 'http-error';
  assert.equal((await call()).status, 502);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await balance(), SIGNUP_CREDITS - 1, 'refunded after upstream HTTP error');

  mode = 'throw';
  assert.equal((await call()).status, 502);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await balance(), SIGNUP_CREDITS - 1, 'refunded after network error');

  mode = 'error-event';
  const failed = await call();
  assert.equal(failed.status, 200);
  await failed.text();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await balance(), SIGNUP_CREDITS - 1, 'refunded when the first event is an error');
});

test('trusted gateway secret bypasses account checks and goes straight to the local agent', async () => {
  let localCalls = 0;
  const handler = createToneAgentGateway({
    gatewaySecret: 'shared-secret',
    service: () => { throw new Error('account service must not be used'); },
    localHandler: async () => {
      localCalls += 1;
      return new Response('ok');
    },
  });
  const trusted = await handler(new Request('http://x/api/tone-agent', { method: 'POST', headers: { [GATEWAY_SECRET_HEADER]: 'shared-secret' }, body: '{}' }));
  assert.equal(trusted.status, 200);
  assert.equal(localCalls, 1);
  await assert.rejects(handler(new Request('http://x/api/tone-agent', { method: 'POST', headers: { [GATEWAY_SECRET_HEADER]: 'wrong' }, body: '{}' })), /must not be used/);
});
