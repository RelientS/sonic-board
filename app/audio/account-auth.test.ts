import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSession,
  emptyAccountState,
  registerUser,
  resolveSession,
  type IdSource,
} from '../account/accounts.ts';
import { hashPassword, verifyPassword } from '../account/password.ts';
import {
  clearSessionCookie,
  createSessionToken,
  hashSessionToken,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
} from '../account/session.ts';

function sequentialIds(): IdSource {
  let id = 0;
  let code = 0;
  return { newId: () => `id-${++id}`, newReferralCode: () => `code${String(++code).padStart(4, '0')}` };
}

test('password hashes are salted scrypt strings that verify only the right password', async () => {
  const first = await hashPassword('correct horse');
  const second = await hashPassword('correct horse');
  assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second, 'per-user salt makes equal passwords hash differently');
  assert.equal(await verifyPassword('correct horse', first), true);
  assert.equal(await verifyPassword('correct horse', second), true);
  assert.equal(await verifyPassword('wrong horse', first), false);
  assert.equal(await verifyPassword('correct horse', 'plain-text'), false);
  assert.equal(await verifyPassword('correct horse', 'scrypt$x$8$1$abc$def'), false);
});

test('session tokens are random 32-byte values and only their digest is stored', () => {
  const token = createSessionToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(createSessionToken(), token);
  const digest = hashSessionToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(token), digest);

  const state = emptyAccountState();
  const registered = registerUser(state, { username: 'alice', passwordHash: 'h', ipHash: 'ip-a' }, 1_000, sequentialIds());
  assert.ok(registered.ok);
  createSession(state, digest, registered.user.id, 1_000);
  assert.equal(JSON.stringify(state).includes(token), false, 'raw token never persisted');
  assert.equal(resolveSession(state, digest, 2_000)?.username, 'alice');
  assert.equal(resolveSession(state, hashSessionToken(createSessionToken()), 2_000), undefined);
  assert.equal(resolveSession(state, digest, 1_000 + SESSION_TTL_MS - 1)?.username, 'alice');
  assert.equal(resolveSession(state, digest, 1_000 + SESSION_TTL_MS), undefined, 'expired after 30 days');
  assert.equal(resolveSession(state, '__proto__', 2_000), undefined);
});

test('session cookie is HttpOnly, Secure, SameSite=Lax with a 30-day lifetime', () => {
  const token = createSessionToken();
  const cookie = sessionCookie(token);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=${token};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=${token}; b=2`, SESSION_COOKIE), token);
  assert.equal(readCookie(`${SESSION_COOKIE}=short`, SESSION_COOKIE), undefined);
  assert.equal(readCookie(null, SESSION_COOKIE), undefined);
});
