// Pure decision logic and stream plumbing for the Tone Agent gateway. The
// route handler composes these; keeping them here makes the 401/402/429
// behaviour testable without a server.
import { AGENT_REQUEST_COST } from './accounts.ts';
import { nodeCrypto } from './node-builtins.ts';
import { REFERRAL_RULE_TEXT } from './shared.ts';

export const GATEWAY_SECRET_HEADER = 'x-sonic-gateway-secret';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 240_000;

export type AgentAccessInput = {
  authenticated: boolean;
  credits: number;
  /** Requests still allowed for this account in the current rate window. */
  rateRemaining: number;
  inFlight: number;
  maxInFlight: number;
};

export type AgentDenyCode = 'login_required' | 'insufficient_credits' | 'rate_limited' | 'busy';
export type AgentAccessDecision =
  | { ok: true }
  | { ok: false; status: 401 | 402 | 429; code: AgentDenyCode; error: string };

export const AGENT_DENY_MESSAGES: Record<AgentDenyCode, string> = {
  login_required: '请先登录后再使用音色 Agent。',
  insufficient_credits: `免费次数已用完。复制你的邀请链接分享给朋友：${REFERRAL_RULE_TEXT}。`,
  rate_limited: '请求太频繁：每个账号每分钟最多 5 次，请稍后再试。',
  busy: '音色 Agent 当前使用人数较多，请稍后再试。',
};

export function deny(code: AgentDenyCode): Extract<AgentAccessDecision, { ok: false }> {
  const status = code === 'login_required' ? 401 : code === 'insufficient_credits' ? 402 : 429;
  return { ok: false, status, code, error: AGENT_DENY_MESSAGES[code] };
}

export function decideAgentAccess(input: AgentAccessInput): AgentAccessDecision {
  if (!input.authenticated) return deny('login_required');
  if (input.credits < AGENT_REQUEST_COST) return deny('insufficient_credits');
  if (input.rateRemaining <= 0) return deny('rate_limited');
  if (input.inFlight >= input.maxInFlight) return deny('busy');
  return { ok: true };
}

/** Timing-safe comparison of the shared gateway secret header. */
export function hasGatewaySecret(headers: Headers, secret: string | undefined) {
  if (!secret) return false;
  const provided = headers.get(GATEWAY_SECRET_HEADER);
  if (!provided) return false;
  const crypto = nodeCrypto();
  const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(provided), digest(secret));
}

export type SseStart = 'pending' | 'output' | 'failed';

/**
 * Looks at the first complete SSE event carrying `data:`. Comment frames
 * (`: connected`, heartbeats) are not output. An `error` event as the first
 * data means the agent failed before producing anything.
 */
export function classifySseStart(buffer: string): SseStart {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  blocks.pop(); // last piece is incomplete (or empty)
  for (const block of blocks) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data) continue;
    try {
      const value = JSON.parse(data) as { type?: unknown };
      if (value && value.type === 'heartbeat') continue;
      return value && value.type === 'error' ? 'failed' : 'output';
    } catch {
      return 'output';
    }
  }
  return 'pending';
}

export type StreamSettlement = 'output' | 'failed' | 'aborted';

const MAX_SCAN_CHARS = 64 * 1024;

/**
 * Passes an SSE body through unchanged while watching whether any agent
 * output was produced. `onSettle` fires exactly once when the stream ends,
 * errors, or is cancelled by the consumer.
 */
export function watchAgentStream(
  source: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; onSettle: (result: StreamSettlement) => void },
) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let scan = '';
  let start: SseStart = 'pending';
  let settled = false;
  const settle = (ended: boolean) => {
    if (settled) return;
    settled = true;
    let result: StreamSettlement;
    if (start === 'output') result = 'output';
    else if (!ended || options.signal?.aborted) result = 'aborted';
    else result = 'failed';
    options.onSettle(result);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        settle(true);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        settle(true);
        controller.close();
        return;
      }
      if (start === 'pending') {
        scan += decoder.decode(chunk.value, { stream: true });
        start = classifySseStart(scan);
        if (start === 'pending' && scan.length > MAX_SCAN_CHARS) start = 'output';
        if (start !== 'pending') scan = '';
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      settle(false);
      await reader.cancel(reason).catch(() => {});
    },
  });
}
