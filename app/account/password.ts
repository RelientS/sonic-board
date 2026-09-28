import { nodeCrypto, toBase64Url } from './node-builtins.ts';

// scrypt N=2^14, r=8, p=1 needs ~16 MiB per hash: safe on a small VPS while
// still costing an attacker real memory per guess.
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

function scrypt(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeCrypto().scrypt(password.normalize('NFKC'), salt, keyLength, { ...options, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Returns `scrypt$N$r$p$<salt b64url>$<hash b64url>`. */
export async function hashPassword(password: string) {
  const salt = nodeCrypto().randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, toBase64Url(salt), toBase64Url(key)].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && nodeCrypto().timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/** Burns the same scrypt cost as a real verify so unknown usernames are not distinguishable by timing. */
export async function verifyAgainstDummy(password: string) {
  dummyHash ??= hashPassword('sonic-board-dummy-password');
  await verifyPassword(password, await dummyHash);
  return false;
}
