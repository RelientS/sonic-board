import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listPrivatePedalModels, listPrivateSkins, readPrivatePedalModel, readPrivateSkin } from '../account/private-assets.ts';

test('pedal photos are served only through their manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-skins-'));
  try {
    await writeFile(join(dir, 'boss-ds1.webp'), new Uint8Array([1, 2, 3]));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([
      { specId: 'ds1-dist', file: 'boss-ds1.webp', widthIn: 2.875, heightIn: 5.125 },
      { specId: 'escape', file: '../secret.webp' },
      { specId: 'png', file: 'boss-ds1.png' },
    ]));
    assert.deepEqual((await listPrivateSkins(dir)).map((entry) => entry.specId), ['ds1-dist']);
    assert.deepEqual([...(await readPrivateSkin('ds1-dist', dir))!], [1, 2, 3]);
    assert.equal(await readPrivateSkin('escape', dir), null);
    assert.equal(await readPrivateSkin('../ds1-dist', dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pedal NAM captures need a slot and stay inside their folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-pedals-'));
  try {
    await writeFile(join(dir, 'fw.nam'), '{"version":"0.5.4"}');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([
      { id: 'fw', file: 'fw.nam', slotId: 'fuzz-war-nam', name: 'Fuzz War', setting: 'Sustain 5' },
      { id: 'noslot', file: 'fw.nam', name: 'x', setting: 'x' },
      { id: 'escape', file: '../x.nam', slotId: 'fuzz-war-nam', name: 'x', setting: 'x' },
    ]));
    assert.deepEqual((await listPrivatePedalModels(dir)).map((entry) => entry.id), ['fw']);
    assert.equal(await readPrivatePedalModel('fw', dir), '{"version":"0.5.4"}');
    assert.equal(await readPrivatePedalModel('escape', dir), null);
    assert.deepEqual(await listPrivatePedalModels(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
