import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerUser } from '../account/accounts.ts';
import { ConcurrencyGate, SlidingWindowLimiter } from '../account/rate-limit.ts';
import { createMutex, JsonAccountStore } from '../account/store.ts';

test('sliding window limiter allows N hits per window per key', () => {
  const limiter = new SlidingWindowLimiter(5, 60_000);
  for (let index = 0; index < 5; index += 1) assert.equal(limiter.tryHit('user-a', 1_000 + index), true);
  assert.equal(limiter.tryHit('user-a', 1_010), false);
  assert.equal(limiter.remaining('user-a', 1_010), 0);
  assert.equal(limiter.retryAfterMs('user-a', 1_010), 60_000 - 10);
  assert.equal(limiter.tryHit('user-b', 1_010), true, 'keys are independent');
  assert.equal(limiter.tryHit('user-a', 61_000), true, 'oldest hit expired');
  assert.equal(limiter.remaining('user-a', 61_000), 0);
  assert.equal(limiter.remaining('user-a', 200_000), 5);
});

test('concurrency gate caps in-flight work and releases idempotently', () => {
  const gate = new ConcurrencyGate(2);
  const first = gate.tryAcquire();
  const second = gate.tryAcquire();
  assert.ok(first && second);
  assert.equal(gate.tryAcquire(), null);
  assert.equal(gate.inFlight, 2);
  first();
  first();
  assert.equal(gate.inFlight, 1);
  assert.ok(gate.tryAcquire());
});

test('mutex serializes async critical sections', async () => {
  const runExclusive = createMutex();
  const order: string[] = [];
  const slow = runExclusive(async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a:end');
  });
  const failing = runExclusive(async () => {
    order.push('b');
    throw new Error('boom');
  });
  const after = runExclusive(async () => {
    order.push('c');
  });
  await slow;
  await assert.rejects(failing, /boom/);
  await after;
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
});

test('JSON store persists atomically and serializes concurrent transactions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-accounts-'));
  try {
    let n = 0;
    const store = new JsonAccountStore(dir, () => 1_000);
    const ids = { newId: () => `id-${++n}`, newReferralCode: () => `code${++n}` };
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.transact((state, now) => {
      const result = registerUser(state, { username: `user${index}`, passwordHash: 'h', ipHash: `ip-${index}` }, now, ids);
      assert.ok(result.ok);
    })));
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(Object.keys(saved.users).length, 8, 'no lost updates');
    assert.deepEqual((await readdir(dir)).sort(), ['accounts.json'], 'no temp or lock files left behind');

    await assert.rejects(store.transact(() => {
      throw new Error('abort transaction');
    }), /abort transaction/);
    assert.equal(await store.read((state) => Object.keys(state.users).length), 8, 'failed transaction does not persist');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
