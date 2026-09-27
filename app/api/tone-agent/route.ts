import { AGENT_REQUEST_COST } from '../../account/accounts.ts';
import {
  decideAgentAccess,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  deny,
  GATEWAY_SECRET_HEADER,
  hasGatewaySecret,
  watchAgentStream,
} from '../../account/gateway.ts';
import { isSameOrigin } from '../../account/http.ts';
import { getAccountService, type AccountService } from '../../account/service.ts';
import { readCookie, SESSION_COOKIE } from '../../account/session.ts';
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


type GatewayDependencies = {
  /** The in-process agent handler used when no upstream is configured. */
  localHandler?: (request: Request) => Promise<Response>;
  service?: () => AccountService;
  upstreamUrl?: string;
  gatewaySecret?: string;
  upstreamTimeoutMs?: number;
  fetch?: typeof fetch;
  requestId?: () => string;
};

function upstreamTimeout(value: number | undefined) {
  const configured = value ?? Number(process.env.AGENT_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

/**
 * Public entry point for /api/tone-agent: requires a session, enforces rate
 * limits and credits, then streams from AGENT_UPSTREAM_URL (or the local
 * handler when unset). One credit is charged on acceptance and refunded when
 * the agent fails before producing any output.
 */
export function createToneAgentGateway(dependencies: GatewayDependencies = {}) {
  const local = dependencies.localHandler ?? createToneAgentPost();
  const fetchUpstream = dependencies.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  return async function POST(request: Request) {
    const requestId = requestIdentifier(dependencies.requestId);
    const json = (body: Record<string, unknown>, status: number) => Response.json(body, {
      status,
      headers: { 'X-Request-ID': requestId, 'Cache-Control': 'no-store' },
    });

    // A trusted gateway (another Sonic Board server holding the shared
    // secret) calls straight into the local agent without account checks.
    const gatewaySecret = dependencies.gatewaySecret ?? process.env.AGENT_GATEWAY_SECRET;
    if (hasGatewaySecret(request.headers, gatewaySecret)) return local(request);

    if (!isSameOrigin(request)) return json({ error: '请求来源无效。' }, 403);
    if (request.signal.aborted) return json({ error: '请求已取消。' }, ABORTED_STATUS);

    const service = (dependencies.service ?? getAccountService)();
    const user = await service.authenticate(readCookie(request.headers.get('cookie'), SESSION_COOKIE));
    if (!user) {
      const denied = deny('login_required');
      return json({ error: denied.error, code: denied.code }, denied.status);
    }

    const upstreamUrl = dependencies.upstreamUrl ?? process.env.AGENT_UPSTREAM_URL;
    if (!upstreamUrl && !dependencies.localHandler && !process.env.TOKEN_SHARE_KEY) return json({ error: '音色 Agent 尚未配置。' }, 503);

    let rawBody: string;
    try {
      rawBody = await readBoundedBody(request);
    } catch (error) {
      if (isAbortError(error)) return json({ error: '请求已取消。' }, ABORTED_STATUS);
      if (error instanceof BodyTooLargeError) return json({ error: '请求内容过大。' }, 413);
      return json({ error: '请求格式不正确。' }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: '请求格式不正确。' }, 400);
    }
    if (!normalizeToneAgentRequest(body)) return json({ error: '当前音色上下文不完整，请刷新页面后重试。' }, 400);

    const decision = decideAgentAccess({
      authenticated: true,
      credits: user.account.credits,
      rateRemaining: service.agentLimiter.remaining(user.id),
      inFlight: service.agentGate.inFlight,
      maxInFlight: service.agentGate.max,
    });
    if (!decision.ok) return json({ error: decision.error, code: decision.code, credits: user.account.credits }, decision.status);

    const release = service.agentGate.tryAcquire();
    if (!release) {
      const denied = deny('busy');
      return json({ error: denied.error, code: denied.code }, denied.status);
    }
    if (!service.agentLimiter.tryHit(user.id)) {
      release();
      const denied = deny('rate_limited');
      return json({ error: denied.error, code: denied.code }, denied.status);
    }

    let charge: Awaited<ReturnType<AccountService['chargeAgentUse']>>;
    try {
      charge = await service.chargeAgentUse(user.id, requestId);
    } catch (error) {
      release();
      logToneAgentError(requestId, error);
      return json({ error: '账户服务暂时不可用，请稍后重试。' }, 503);
    }
    if (!charge.ok) {
      release();
      const denied = deny('insufficient_credits');
      return json({ error: denied.error, code: denied.code, credits: charge.balance }, denied.status);
    }

    const refund = () => {
      void service.refundAgentUse(user.id, requestId).catch((error: unknown) => logToneAgentError(requestId, error));
    };
    const upstreamAbort = new AbortController();
    const onClientAbort = () => upstreamAbort.abort(abortError());
    request.signal.addEventListener('abort', onClientAbort, { once: true });
    const timer = upstreamUrl
      ? setTimeout(() => upstreamAbort.abort(new DOMException('Upstream timed out', 'TimeoutError')), upstreamTimeout(dependencies.upstreamTimeoutMs))
      : undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener('abort', onClientAbort);
      release();
    };
    const fail = (status: number, error: string) => {
      cleanup();
      if (request.signal.aborted) return json({ error: '请求已取消。' }, ABORTED_STATUS);
      refund();
      return json({ error, credits: charge.balance + AGENT_REQUEST_COST }, status);
    };

    let response: Response;
    try {
      response = upstreamUrl
        ? await fetchUpstream(upstreamUrl, {
          method: 'POST',
          // Built from scratch: cookies and other client headers never leave this server.
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'X-Request-ID': requestId,
            ...(gatewaySecret ? { [GATEWAY_SECRET_HEADER]: gatewaySecret } : {}),
          },
          body: rawBody,
          signal: upstreamAbort.signal,
        })
        : await local(new Request(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody,
          signal: upstreamAbort.signal,
        }));
    } catch (error) {
      if (!request.signal.aborted) logToneAgentError(requestId, error);
      return fail(502, '音色 Agent 暂时不可用，请稍后重试。');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
      if (!upstreamUrl && !response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: unknown };
        return fail(response.status, typeof payload.error === 'string' ? payload.error : '音色 Agent 暂时不可用，请稍后重试。');
      }
      await response.body?.cancel().catch(() => {});
      console.error('[tone-agent] upstream rejected', { requestId, status: response.status });
      return fail(502, response.status === 429 ? '音色 Agent 暂时繁忙，请稍后重试。' : '音色 Agent 暂时不可用，请稍后重试。');
    }

    const stream = watchAgentStream(response.body, {
      signal: request.signal,
      onSettle: (result) => {
        cleanup();
        upstreamAbort.abort(abortError());
        if (result === 'failed') refund();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-ID': requestId,
        'X-Credits-Remaining': String(charge.balance),
      },
    });
  };
}

export const POST = createToneAgentGateway();
