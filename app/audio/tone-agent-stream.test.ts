import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isToneAgentAbort,
  MAX_TONE_AGENT_SSE_BUFFER_BYTES,
  MAX_TONE_AGENT_SSE_FRAME_BYTES,
  parseToneAgentSseChunk,
  requestToneAgentStream,
  ToneAgentStreamProtocolError,
  TONE_AGENT_STREAM_PROTOCOL_ERROR,
  TONE_AGENT_STREAM_TOO_LARGE_ERROR,
} from '../agent/tone-agent-stream.ts';
import type { ToneAgentPlan, ToneAgentRequest } from '../agent/tone-agent-runtime.ts';

test('agent stream parser keeps partial SSE blocks and emits complete events', () => {
  const first = parseToneAgentSseChunk('', 'data: {"type":"thinking_delta","delta":"正在读取"}\r\n\r\ndata: {"type":"trace",');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'thinking_delta');
  assert.match(first.rest, /trace/);

  const second = parseToneAgentSseChunk(first.rest, '"step":{"id":"1","kind":"observe","status":"completed","title":"读取当前音色","detail":"5 块效果器","toolName":"inspect_board"}}\n\n');
  assert.equal(second.rest, '');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].type, 'trace');
});

test('agent stream parser accepts LF, CRLF, and lone-CR delimiters across chunks', () => {
  const first = parseToneAgentSseChunk('', 'data: {"type":"text_delta","delta":"第一段"}\r\n\r\ndata: {"type":"text_delta","delta":"第二段"}\r');
  assert.deepEqual(first.events, [{ type: 'text_delta', delta: '第一段' }]);
  assert.equal(first.rest, 'data: {"type":"text_delta","delta":"第二段"}\r');

  const second = parseToneAgentSseChunk(first.rest, '\n\r\ndata: {"type":"text_delta","delta":"第三段"}\r\r');
  assert.deepEqual(second.events, [{ type: 'text_delta', delta: '第二段' }]);
  const flushed = parseToneAgentSseChunk(second.rest, '', true);
  assert.deepEqual(flushed.events, [{ type: 'text_delta', delta: '第三段' }]);
  assert.equal(flushed.rest, '');
});

test('agent stream parser accepts heartbeat comments without creating fake messages', () => {
  const result = parseToneAgentSseChunk('', ': heartbeat\n\ndata: {"type":"text_delta","delta":"可以。"}\n\n');
  assert.deepEqual(result.events, [{ type: 'text_delta', delta: '可以。' }]);
});

test('agent stream parser ignores the optional [DONE] sentinel', () => {
  const result = parseToneAgentSseChunk('', 'data: [DONE]\r\n\r\ndata: {"type":"text_delta","delta":"仍可继续"}\r\n\r\n');
  assert.deepEqual(result.events, [{ type: 'text_delta', delta: '仍可继续' }]);
});

test('agent stream parser turns malformed JSON and event shapes into a user-safe protocol error', () => {
  for (const block of [
    'data: {"type":\n\n',
    'data: {"type":"complete","plan":{}}\n\n',
  ]) {
    assert.throws(
      () => parseToneAgentSseChunk('', block),
      (error: unknown) => error instanceof ToneAgentStreamProtocolError
        && error.message === TONE_AGENT_STREAM_PROTOCOL_ERROR
        && !error.message.includes('Unexpected'),
    );
  }
});

test('agent stream parser bounds complete frames and partial buffers', () => {
  assert.throws(
    () => parseToneAgentSseChunk('', `data: ${'x'.repeat(MAX_TONE_AGENT_SSE_FRAME_BYTES)}\n\n`),
    (error: unknown) => error instanceof ToneAgentStreamProtocolError && error.message === TONE_AGENT_STREAM_TOO_LARGE_ERROR,
  );
  assert.throws(
    () => parseToneAgentSseChunk('', `data: ${'x'.repeat(MAX_TONE_AGENT_SSE_BUFFER_BYTES + 1)}`),
    (error: unknown) => error instanceof ToneAgentStreamProtocolError && error.message === TONE_AGENT_STREAM_TOO_LARGE_ERROR,
  );
});

type FakeReader = {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
};

function responseWithReader(reader: FakeReader) {
  return { ok: true, body: { getReader: () => reader } } as unknown as Response;
}

function makeReader(chunks: string[], options: { onCancel?: () => void; onRelease?: () => void } = {}): FakeReader {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: encoder.encode(chunks[index++]) };
    },
    async cancel() {
      options.onCancel?.();
    },
    releaseLock() {
      options.onRelease?.();
    },
  };
}

function withFetch(response: Response, operation: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => response;
  return operation().finally(() => {
    globalThis.fetch = previous;
  });
}

const plan: ToneAgentPlan = { message: '完成', actions: [], provider: 'pi', trace: [] };
const requestBody = {} as ToneAgentRequest;

test('agent stream request returns on complete and always cancels/releases its reader', async () => {
  let cancelled = false;
  let released = false;
  const reader = makeReader([`data: ${JSON.stringify({ type: 'complete', plan })}\n\n`], {
    onCancel: () => { cancelled = true; },
    onRelease: () => { released = true; },
  });
  const received: string[] = [];
  await withFetch(responseWithReader(reader), async () => {
    const result = await requestToneAgentStream(requestBody, { onEvent: (event) => received.push(event.type) });
    assert.deepEqual(result, plan);
  });
  assert.deepEqual(received, ['complete']);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('agent stream request rejects clean EOF without complete or error', async () => {
  let cancelled = false;
  let released = false;
  const reader = makeReader(['data: {"type":"text_delta","delta":"未完成"}\n\n'], {
    onCancel: () => { cancelled = true; },
    onRelease: () => { released = true; },
  });
  await withFetch(responseWithReader(reader), async () => {
    await assert.rejects(
      requestToneAgentStream(requestBody),
      (error: unknown) => error instanceof Error && error.message === 'Agent 流在完成前结束。',
    );
  });
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('agent stream request treats error as terminal and preserves its safe message', async () => {
  let cancelled = false;
  let released = false;
  const reader = makeReader(['data: {"type":"error","error":"音色 Agent 暂时不可用。"}\n\n'], {
    onCancel: () => { cancelled = true; },
    onRelease: () => { released = true; },
  });
  await withFetch(responseWithReader(reader), async () => {
    await assert.rejects(
      requestToneAgentStream(requestBody),
      (error: unknown) => error instanceof Error && error.message === '音色 Agent 暂时不可用。',
    );
  });
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('agent stream request preserves expected AbortError and still cleans up', async () => {
  let cancelled = false;
  let released = false;
  const reader: FakeReader = {
    async read() {
      throw new DOMException('Aborted', 'AbortError');
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {
      released = true;
    },
  };
  await withFetch(responseWithReader(reader), async () => {
    await assert.rejects(
      requestToneAgentStream(requestBody),
      (error: unknown) => isToneAgentAbort(error),
    );
  });
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('agent stream request classifies a signal-triggered reader failure as AbortError', async () => {
  const controller = new AbortController();
  const reader: FakeReader = {
    async read() {
      controller.abort();
      throw new TypeError('socket closed');
    },
    async cancel() {},
    releaseLock() {},
  };
  await withFetch(responseWithReader(reader), async () => {
    await assert.rejects(
      requestToneAgentStream(requestBody, { signal: controller.signal }),
      (error: unknown) => isToneAgentAbort(error),
    );
  });
});
