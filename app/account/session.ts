import { nodeCrypto, toBase64Url } from './node-builtins.ts';

export const SESSION_COOKIE = 'sb_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSessionToken() {
  return toBase64Url(nodeCrypto().randomBytes(32));
}

/** Only this digest is persisted; the raw token lives solely in the browser cookie. */
export function hashSessionToken(token: string) {
  return nodeCrypto().createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readCookie(header: string | null, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : undefined;
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
