import type { ToneAgentPlan, ToneAgentRequest, ToneAgentStreamEvent } from './tone-agent-runtime.ts';

export function parseToneAgentSseChunk(previous: string, chunk: string) {
  let buffer = `${previous}${chunk}`.replace(/\r\n/g, '\n');
  const events: ToneAgentStreamEvent[] = [];
  let boundary = buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (data) events.push(JSON.parse(data) as ToneAgentStreamEvent);
    boundary = buffer.indexOf('\n\n');
  }
  return { events, rest: buffer };
}

export async function requestToneAgentStream(
  body: ToneAgentRequest,
  options: { signal?: AbortSignal; onEvent?: (event: ToneAgentStreamEvent) => void } = {},
): Promise<ToneAgentPlan> {
  const response = await fetch('/api/tone-agent', {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Agent 请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('Agent 流不可用。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let plan: ToneAgentPlan | undefined;
  while (true) {
    const { done, value } = await reader.read();
    const parsed = parseToneAgentSseChunk(buffer, decoder.decode(value, { stream: !done }));
    buffer = parsed.rest;
    for (const event of parsed.events) {
      options.onEvent?.(event);
      if (event.type === 'complete') plan = event.plan;
      if (event.type === 'error') throw new Error(event.error);
    }
    if (done) break;
  }
  if (!plan) throw new Error('Agent 流在完成前结束。');
  return plan;
}

export function isToneAgentAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

