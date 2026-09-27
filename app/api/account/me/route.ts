import { jsonResponse } from '../../../account/http.ts';
import { getAccountService } from '../../../account/service.ts';
import { clearSessionCookie, readCookie, SESSION_COOKIE } from '../../../account/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await getAccountService().authenticate(token);
  if (!user) {
    return jsonResponse({ account: null }, 200, token ? { 'Set-Cookie': clearSessionCookie() } : {});
  }
  return jsonResponse({ account: user.account });
}
