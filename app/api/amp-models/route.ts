import { jsonResponse } from '../../account/http.ts';
import { isOwnerUsername, listPrivateAmps, readPrivateAmp } from '../../account/private-amps.ts';
import { getAccountService } from '../../account/service.ts';
import { readCookie, SESSION_COOKIE } from '../../account/session.ts';

export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

/**
 * GET /api/amp-models        -> { amps: [...] } for the owner, { amps: [] } otherwise
 * GET /api/amp-models?id=... -> the NAM model JSON (owner only)
 */
export async function GET(request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await getAccountService().authenticate(token);
  const owner = Boolean(user && isOwnerUsername(user.account.username));
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    const amps = owner ? await listPrivateAmps() : [];
    return jsonResponse({ amps: amps.map(({ id: ampId, amp, setting, author, url, sampleRate, loudness, format, cab }) => ({ id: ampId, amp, setting, author, url, sampleRate, loudness, format, cab })) }, 200, PRIVATE_HEADERS);
  }
  if (!owner) return jsonResponse({ error: 'forbidden' }, user ? 403 : 401, PRIVATE_HEADERS);
  const model = await readPrivateAmp(id);
  if (model === null) return jsonResponse({ error: 'not_found' }, 404, PRIVATE_HEADERS);
  return new Response(model, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS } });
}
