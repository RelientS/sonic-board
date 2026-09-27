import { PUBLIC_SITE_ORIGIN } from './shared.ts';

/**
 * Client address as seen by the edge. Cloudflare sets CF-Connecting-IP and
 * Caddy sets X-Forwarded-For; the Node server itself only listens on
 * 127.0.0.1, so without either header every caller is the local proxy.
 */
export function clientIp(headers: Headers) {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  return 'local';
}

function siteOrigins(request: Request) {
  const origins = new Set<string>();
  for (const origin of [process.env.SONIC_SITE_ORIGIN, PUBLIC_SITE_ORIGIN]) {
    if (origin) origins.add(origin.replace(/\/+$/, ''));
  }
  try {
    // Browsers always send the real Host, so the request's own origin is safe
    // to accept (covers localhost dev and alternate hostnames).
    const url = new URL(request.url);
    origins.add(url.origin);
    const host = request.headers.get('host');
    if (host) {
      origins.add(`https://${host}`);
      origins.add(`http://${host}`);
    }
  } catch {
    // Ignore malformed URLs; the configured origins still apply.
  }
  return origins;
}

/** Same-origin check: Origin (or Referer) must match the site, or be absent. */
export function isSameOrigin(request: Request) {
  const allowed = siteOrigins(request);
  const origin = request.headers.get('origin');
  if (origin !== null) return origin !== 'null' && allowed.has(origin);
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return true;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

const MAX_ACCOUNT_BODY_BYTES = 4 * 1024;

/** Reads a small JSON object body; returns null on anything malformed or oversized. */
export async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_ACCOUNT_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ACCOUNT_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
