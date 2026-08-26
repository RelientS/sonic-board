import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveSessionController } from './live-session-controller.ts';

type Session = { id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test('a stopped pending playback can never become the active session later', async () => {
  const pending = deferred<Session>();
  const disposed: string[] = [];
  const controller = new LiveSessionController<string, Session>(
    async () => pending.promise,
    async (session) => { disposed.push(session.id); },
  );

  const starting = controller.start('wet');
  await controller.stop();
  pending.resolve({ id: 'stale-wet' });

  assert.equal(await starting, null);
  assert.equal(controller.current, null);
  assert.deepEqual(disposed, ['stale-wet']);
});

test('a late wet session cannot replace a newer dry session', async () => {
  const wet = deferred<Session>();
  const dry = deferred<Session>();
  const disposed: string[] = [];
  const controller = new LiveSessionController<string, Session>(
    async (mode) => mode === 'wet' ? wet.promise : dry.promise,
    async (session) => { disposed.push(session.id); },
  );

  const startingWet = controller.start('wet');
  await controller.stop();
  const startingDry = controller.start('dry');
  dry.resolve({ id: 'dry' });
  assert.deepEqual(await startingDry, { id: 'dry' });

  wet.resolve({ id: 'stale-wet' });
  assert.equal(await startingWet, null);
  assert.deepEqual(controller.current, { id: 'dry' });
  assert.deepEqual(disposed, ['stale-wet']);
});
