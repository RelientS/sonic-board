import { isSameOrigin, jsonResponse } from '../../../account/http.ts';
import { getAccountService } from '../../../account/service.ts';
import { clearSessionCookie, readCookie, SESSION_COOKIE } from '../../../account/session.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return jsonResponse({ error: '请求来源无效。' }, 403);
  await getAccountService().logout(readCookie(request.headers.get('cookie'), SESSION_COOKIE));
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
