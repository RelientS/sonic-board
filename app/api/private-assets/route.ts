import { jsonResponse } from '../../account/http.ts';
import { listPrivatePedalModels, listPrivateSkins, readPrivatePedalModel, readPrivateSkin, requestRole } from '../../account/private-assets.ts';

export const dynamic = 'force-dynamic';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

/**
 * GET /api/private-assets                 -> { skins, pedalModels } (empty unless owner)
 * GET /api/private-assets?skin=<specId>   -> the pedal photo (owner only)
 * GET /api/private-assets?pedalModel=<id> -> a pedal NAM capture (owner only)
 */
export async function GET(request: Request) {
  const role = await requestRole(request);
  const params = new URL(request.url).searchParams;
  const skin = params.get('skin');
  const pedalModel = params.get('pedalModel');
  if (!skin && !pedalModel) {
    if (role !== 'owner') return jsonResponse({ skins: [], pedalModels: [] }, 200, PRIVATE);
    const skins = (await listPrivateSkins()).map(({ specId, widthIn, heightIn, switch: footswitch, led }) => ({ specId, widthIn, heightIn, switch: footswitch, led }));
    const pedalModels = (await listPrivatePedalModels()).map(({ id, slotId, name, setting, author, url, loudness }) => ({ id, slotId, name, setting, author, url, loudness }));
    return jsonResponse({ skins, pedalModels }, 200, PRIVATE);
  }
  if (role !== 'owner') return jsonResponse({ error: 'forbidden' }, role === 'user' ? 403 : 401, PRIVATE);
  if (skin) {
    const image = await readPrivateSkin(skin);
    if (!image) return jsonResponse({ error: 'not_found' }, 404, PRIVATE);
    // Private but cacheable in the owner's browser for a day.
    return new Response(new Uint8Array(image), { status: 200, headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' } });
  }
  const model = await readPrivatePedalModel(pedalModel!);
  if (model === null) return jsonResponse({ error: 'not_found' }, 404, PRIVATE);
  return new Response(model, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE } });
}
