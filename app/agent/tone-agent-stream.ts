import type { ToneAgentPlan, ToneAgentRequest, ToneAgentStreamEvent } from './tone-agent-runtime.ts';

export const MAX_TONE_AGENT_SSE_FRAME_BYTES = 128 * 1024;
export const MAX_TONE_AGENT_SSE_BUFFER_BYTES = 256 * 1024;
export const TONE_AGENT_STREAM_PROTOCOL_ERROR = 'Agent 流协议无效，请稍后重试。';
export const TONE_AGENT_STREAM_TOO_LARGE_ERROR = 'Agent 流数据过大，请稍后重试。';

export class ToneAgentStreamProtocolError extends Error {
  constructor(message = TONE_AGENT_STREAM_PROTOCOL_ERROR) {
    super(message);
    this.name = 'ToneAgentStreamProtocolError';
  }
}

function streamTooLargeError() {
  return new ToneAgentStreamProtocolError(TONE_AGENT_STREAM_TOO_LARGE_ERROR);
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeLineEndings(value: string, flush: boolean) {
  const hasPendingCarriageReturn = !flush && value.endsWith('\r');
  const complete = hasPendingCarriageReturn ? value.slice(0, -1) : value;
  const normalized = complete.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return hasPendingCarriageReturn ? `${normalized}\r` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTraceStep(value: unknown) {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.kind === 'observe' || value.kind === 'tool-call' || value.kind === 'tool-result')
    && (value.status === 'completed' || value.status === 'failed')
    && typeof value.title === 'string'
    && typeof value.detail === 'string'
    && (value.toolName === undefined || typeof value.toolName === 'string');
}

function isPlan(value: unknown): value is ToneAgentPlan {
  return isRecord(value)
    && typeof value.message === 'string'
    && Array.isArray(value.actions)
    && (value.provider === 'pi' || value.provider === 'local')
    && Array.isArray(value.trace)
    && value.trace.every(isTraceStep);
}

function parseToneAgentSseBlock(block: string) {
  const data = block.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return undefined;

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ToneAgentStreamProtocolError();
  }
  if (!isRecord(value) || typeof value.type !== 'string') throw new ToneAgentStreamProtocolError();

  const eventType = value.type;
  if (eventType === 'thinking_delta' || eventType === 'text_delta') {
    if (typeof value.delta !== 'string') throw new ToneAgentStreamProtocolError();
  } else if (eventType === 'trace') {
    if (!isTraceStep(value.step)) throw new ToneAgentStreamProtocolError();
  } else if (eventType === 'complete') {
    if (!isPlan(value.plan)) throw new ToneAgentStreamProtocolError();
  } else if (eventType === 'error') {
    if (typeof value.error !== 'string' || !value.error.trim()) throw new ToneAgentStreamProtocolError();
  } else if (eventType !== 'heartbeat') {
    // Ignore unknown event types so additive server events do not break this client.
    return undefined;
  }
  return value as ToneAgentStreamEvent;
}

export function parseToneAgentSseChunk(previous: string, chunk: string, flush = false) {
  if (typeof previous !== 'string' || typeof chunk !== 'string') throw new ToneAgentStreamProtocolError();
  const previousBytes = utf8ByteLength(previous);
  const chunkBytes = utf8ByteLength(chunk);
  if (previousBytes > MAX_TONE_AGENT_SSE_FRAME_BYTES || previousBytes + chunkBytes > MAX_TONE_AGENT_SSE_BUFFER_BYTES) {
    throw streamTooLargeError();
  }

  let buffer = normalizeLineEndings(`${previous}${chunk}`, flush);
  const events: ToneAgentStreamEvent[] = [];
  let boundary = buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    if (utf8ByteLength(block) > MAX_TONE_AGENT_SSE_FRAME_BYTES) throw streamTooLargeError();
    buffer = buffer.slice(boundary + 2);
    const event = parseToneAgentSseBlock(block);
    if (event) events.push(event);
    boundary = buffer.indexOf('\n\n');
  }
  if (utf8ByteLength(buffer) > MAX_TONE_AGENT_SSE_FRAME_BYTES) throw streamTooLargeError();
  return { events, rest: buffer };
}

function makeAbortError() {
  return new DOMException('Aborted', 'AbortError');
}

export async function requestToneAgentStream(
  body: ToneAgentRequest,
  options: { signal?: AbortSignal; onEvent?: (event: ToneAgentStreamEvent) => void } = {},
): Promise<ToneAgentPlan> {
  if (options.signal?.aborted) throw makeAbortError();

  let response: Response;
  try {
    response = await fetch('/api/tone-agent', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted && !isToneAgentAbort(error)) throw makeAbortError();
    throw error;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Agent 请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('Agent 流不可用。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let plan: ToneAgentPlan | undefined;
  let terminal: 'complete' | 'error' | undefined;
  let terminalError: Error | undefined;
  try {
    while (!terminal) {
      if (options.signal?.aborted) throw makeAbortError();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (options.signal?.aborted && !isToneAgentAbort(error)) throw makeAbortError();
        throw error;
      }
      if (options.signal?.aborted) throw makeAbortError();

      let text: string;
      try {
        text = decoder.decode(result.value, { stream: !result.done });
      } catch {
        throw new ToneAgentStreamProtocolError();
      }
      const parsed = parseToneAgentSseChunk(buffer, text, result.done);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        options.onEvent?.(event);
        if (event.type === 'complete') {
          plan = event.plan;
          terminal = 'complete';
          break;
        }
        if (event.type === 'error') {
          terminal = 'error';
          terminalError = new Error(event.error);
          break;
        }
      }
      if (result.done) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or aborted.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A custom stream may have released the lock while shutting down.
      }
    }
  }

  if (terminal === 'error') throw terminalError ?? new ToneAgentStreamProtocolError();
  if (!terminal || !plan) throw new Error('Agent 流在完成前结束。');
  return plan;
}

export function isToneAgentAbort(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  return 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}
