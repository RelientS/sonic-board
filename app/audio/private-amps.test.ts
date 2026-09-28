import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isOwnerUsername, listPrivateAmps, readPrivateAmp } from '../account/private-amps.ts';

test('only listed owners get private amps', () => {
  assert.equal(isOwnerUsername('Relient', 'relient, other'), true);
  assert.equal(isOwnerUsername('someone', 'relient'), false);
  assert.equal(isOwnerUsername('relient', ''), false);
  assert.equal(isOwnerUsername('relient', undefined), false);
});

test('private amp files are read only through the manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-amps-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'twin.nam'), '{"version":"0.5.4"}');
    await writeFile(join(dir, 'secret.txt'), 'nope');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([
      { id: 'twin', file: 'twin.nam', amp: 'Twin Reverb', setting: 'clean' },
      { id: 'escape', file: '../secret.nam', amp: 'x', setting: 'x' },
      { id: 'Bad ID', file: 'twin.nam', amp: 'x', setting: 'x' },
    ]));
    assert.deepEqual((await listPrivateAmps(dir)).map((entry) => entry.id), ['twin']);
    assert.equal(await readPrivateAmp('twin', dir), '{"version":"0.5.4"}');
    assert.equal(await readPrivateAmp('escape', dir), null);
    assert.equal(await readPrivateAmp('../secret', dir), null);
    assert.deepEqual(await listPrivateAmps(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
