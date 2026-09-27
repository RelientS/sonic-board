import { clientIp, isSameOrigin, jsonResponse, readSmallJson } from '../../../account/http.ts';
import { getAccountService } from '../../../account/service.ts';
import { sessionCookie } from '../../../account/session.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonResponse({ error: '请求来源无效。' }, 403);
  const body = await readSmallJson(request);
  if (!body) return jsonResponse({ error: '请求格式不正确。' }, 400);
  const result = await getAccountService().register({
    username: body.username,
    password: body.password,
    referralCode: body.ref,
    ip: clientIp(request.headers),
  });
  if (!result.ok) return jsonResponse({ error: result.error }, result.status);
  return jsonResponse({ account: result.account }, 201, { 'Set-Cookie': sessionCookie(result.token) });
}
