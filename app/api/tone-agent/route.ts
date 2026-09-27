import { MAX_TONE_AGENT_REQUEST_BYTES } from '../../agent/tone-agent-api.ts';
import { normalizeToneAgentRequest, runToneAgent } from '../../agent/tone-agent-pi.ts';
import type { ToneAgentStreamEvent } from '../../agent/tone-agent-runtime.ts';

const ABORTED_STATUS = 499;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

type ToneAgentRunner = typeof runToneAgent;

type RouteDependencies = {
  runToneAgent?: ToneAgentRunner;
  heartbeatIntervalMs?: number;
  requestId?: () => string;
};

class BodyTooLargeError extends Error {}
class InvalidBodyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function statusOf(error: unknown) {
  if (!isRecord(error)) return undefined;
  return typeof error.status === 'number' && Number.isInteger(error.status) ? error.status : undefined;
}

export function mapToneAgentError(error: unknown) {
  if (isAbortError(error)) return null;
  const status = statusOf(error);
  if (status === 401 || status === 403) return '音色 Agent 配置暂不可用。';
  if (status === 429 || (status !== undefined && status >= 500)) return '音色 Agent 暂时繁忙，请稍后重试。';
  return '音色 Agent 暂时不可用，请稍后重试。';
}

function logToneAgentError(requestId: string, error: unknown) {
  const status = statusOf(error);
  const detail = error instanceof Error ? error.message.replace(/(?:sk|token|key)[-_a-z0-9]*[=:][^\s,;)}]+/gi, '[redacted]').slice(0, 500) : '未知错误';
  console.error('[tone-agent]', { requestId, status, detail });
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

async function readBoundedBody(request: Request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new InvalidBodyError('invalid content length');
    if (parsedLength > MAX_TONE_AGENT_REQUEST_BYTES) throw new BodyTooLargeError('request body too large');
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = false;
  const cancelReader = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  if (request.signal.aborted) {
    cancelReader();
    throw abortError();
  }
  request.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (aborted || request.signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_TONE_AGENT_REQUEST_BYTES) {
        await reader.cancel('request body too large').catch(() => {});
        throw new BodyTooLargeError('request body too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (aborted || request.signal.aborted) throw abortError();
    throw error;
  } finally {
    request.signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidBodyError('invalid utf-8');
  }
}

function requestIdentifier(factory: (() => string) | undefined) {
  if (factory) return factory();
  try {
    return crypto.randomUUID();
  } catch {
    return 'unknown';
  }
}

export function createToneAgentPost(dependencies: RouteDependencies = {}) {
  const runner = dependencies.runToneAgent ?? runToneAgent;
  const heartbeatIntervalMs = Math.max(1, dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

  return async function POST(request: Request) {
    const requestId = requestIdentifier(dependencies.requestId);
    const json = (body: Record<string, string>, status: number) => Response.json(body, {
      status,
      headers: { 'X-Request-ID': requestId },
    });

    if (request.signal.aborted) return json({ error: '请求已取消。' }, ABORTED_STATUS);
    const apiKey = process.env.TOKEN_SHARE_KEY;
    if (!apiKey) return json({ error: '音色 Agent 尚未配置。' }, 503);

    let rawBody: string;
    try {
      rawBody = await readBoundedBody(request);
    } catch (error) {
      if (isAbortError(error)) return json({ error: '请求已取消。' }, ABORTED_STATUS);
      if (error instanceof BodyTooLargeError) return json({ error: '请求内容过大。' }, 413);
      return json({ error: '请求格式不正确。' }, 400);
    }
    if (request.signal.aborted) return json({ error: '请求已取消。' }, ABORTED_STATUS);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: '请求格式不正确。' }, 400);
    }
    const input = normalizeToneAgentRequest(body);
    if (!input) return json({ error: '当前音色上下文不完整，请刷新页面后重试。' }, 400);
    if (request.signal.aborted) return json({ error: '请求已取消。' }, ABORTED_STATUS);

    const encoder = new TextEncoder();
    let closed = false;
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cancelStream = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const agentController = new AbortController();
        const finish = (closeController: boolean) => {
          if (closed) return;
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          request.signal.removeEventListener('abort', onRequestAbort);
          agentController.abort();
          if (closeController && !cancelled) {
            try {
              controller.close();
            } catch {
              // The consumer may have closed the stream concurrently.
            }
          }
        };
        const onRequestAbort = () => finish(true);
        cancelStream = () => {
          cancelled = true;
          finish(false);
        };
        if (request.signal.aborted) {
          finish(true);
          return;
        }
        request.signal.addEventListener('abort', onRequestAbort, { once: true });

        const enqueue = (value: string) => {
          if (closed || controller.desiredSize === null) return false;
          try {
            controller.enqueue(encoder.encode(value));
            return true;
          } catch {
            cancelled = true;
            finish(false);
            return false;
          }
        };
        const send = (event: ToneAgentStreamEvent) => {
          if (!enqueue(`data: ${JSON.stringify(event)}\n\n`)) return;
        };

        if (!enqueue(': connected\n\n')) return;
        heartbeat = setInterval(() => { enqueue(': heartbeat\n\n'); }, heartbeatIntervalMs);
        void Promise.resolve().then(() => {
          if (closed || request.signal.aborted || agentController.signal.aborted) return undefined;
          return runner(apiKey, input, {
            signal: agentController.signal,
            sessionId: `sonic-board-${requestId}`,
            onEvent: send,
          });
        }).then((plan) => {
          if (plan && !closed) send({ type: 'complete', plan });
        }).catch((error) => {
          if (closed || request.signal.aborted || agentController.signal.aborted || isAbortError(error)) return;
          const message = mapToneAgentError(error);
          if (!message) return;
          logToneAgentError(requestId, error);
          send({ type: 'error', error: `${message}（请求 ID：${requestId}）` });
        }).finally(() => finish(true));
      },
      cancel() {
        cancelStream();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-ID': requestId,
      },
    });
  };
}

export const POST = createToneAgentPost();
