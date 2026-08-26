import { normalizeToneAgentRequest, runToneAgent } from '../../agent/tone-agent-pi.ts';
import type { ToneAgentStreamEvent } from '../../agent/tone-agent-runtime.ts';

export async function POST(request: Request) {
  const apiKey = process.env.TOKEN_SHARE_KEY;
  if (!apiKey) return Response.json({ error: '音色 Agent 尚未配置。' }, { status: 503 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求格式不正确。' }, { status: 400 });
  }
  const input = normalizeToneAgentRequest(body);
  if (!input) return Response.json({ error: '当前音色上下文不完整，请刷新页面后重试。' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: ToneAgentStreamEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      controller.enqueue(encoder.encode(': connected\n\n'));
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 10_000);

      void runToneAgent(apiKey, input, {
        signal: request.signal,
        sessionId: `sonic-board-${crypto.randomUUID()}`,
        onEvent: send,
      }).then((plan) => send({ type: 'complete', plan })).catch((error) => {
        if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        send({ type: 'error', error: error instanceof Error ? error.message : '音色 Agent 暂时不可用。' });
      }).finally(() => {
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
