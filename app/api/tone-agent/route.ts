import { buildToneAgentInput, normalizeRemoteTonePlan, parseResponsesText, parseToneAgentJson } from '../../agent/tone-agent-api';

const RESPONSES_URL = 'https://token-share.app/v1/responses';
const MODEL = 'gpt-5.6-terra';

export async function POST(request: Request) {
  const apiKey = process.env.TOKEN_SHARE_KEY;
  if (!apiKey) return Response.json({ error: '音色 Agent 尚未配置。' }, { status: 503 });

  let prompt = '';
  try {
    const body = await request.json() as { prompt?: unknown };
    prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 240) : '';
  } catch {
    return Response.json({ error: '请求格式不正确。' }, { status: 400 });
  }
  if (!prompt) return Response.json({ error: '请先描述想要的声音。' }, { status: 400 });

  try {
    const upstream = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-session-id': `sonic-board-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ model: MODEL, input: buildToneAgentInput(prompt) }),
    });
    if (!upstream.ok) return Response.json({ error: '模型服务暂时不可用。' }, { status: 502 });
    const payload = await upstream.json() as unknown;
    const text = parseResponsesText(payload);
    const plan = text ? normalizeRemoteTonePlan(parseToneAgentJson(text)) : null;
    if (!plan) return Response.json({ error: '模型返回的音色方案未通过参数校验。' }, { status: 502 });
    return Response.json({ plan, engine: MODEL });
  } catch {
    return Response.json({ error: '模型服务暂时不可用。' }, { status: 502 });
  }
}
