import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNamModelRecord,
  parseNamModel,
  type NamModelStorage,
  NamModelRepository,
} from './nam-model.ts';

function modelJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: '0.5.2',
    architecture: 'WaveNet',
    config: { layers: [{ input_size: 1, condition_size: 1, head_size: 1, channels: 2, kernel_size: 2, dilations: [1] }] },
    metadata: {
      name: 'Fuzz War',
      gear_make: 'Death By Audio',
      gear_model: 'Fuzz War',
      sample_rate: 48_000,
    },
    sample_rate: 48_000,
    weights: [0.25, -0.5, 0.75],
    ...overrides,
  });
}

test('parses a supported local NAM file without removing its model payload', () => {
  const text = modelJson();
  const parsed = parseNamModel(text, 'Fuzz War.nam');

  assert.equal(parsed.fileName, 'Fuzz War.nam');
  assert.equal(parsed.name, 'Fuzz War');
  assert.equal(parsed.architecture, 'WaveNet');
  assert.equal(parsed.sampleRate, 48_000);
  assert.equal(parsed.modelJson, text);
});

test('rejects files that are not usable A1 NAM model documents', () => {
  assert.throws(() => parseNamModel('{}', 'empty.nam'), /NAM/);
  assert.throws(() => parseNamModel(modelJson({ architecture: 'Transformer' }), 'future.nam'), /architecture/i);
  assert.throws(() => parseNamModel(modelJson({ weights: [] }), 'empty-weights.nam'), /weights/i);
  assert.throws(() => parseNamModel(modelJson(), 'model.json'), /\.nam/i);
});

test('stores one private model per pedal slot without placing it in presets', async () => {
  const entries = new Map<string, ReturnType<typeof createNamModelRecord>>();
  const storage: NamModelStorage = {
    get: async (slotId) => entries.get(slotId) ?? null,
    list: async () => [...entries.values()],
    put: async (record) => { entries.set(record.slotId, record); },
    remove: async (slotId) => { entries.delete(slotId); },
  };
  const repository = new NamModelRepository(storage);
  const record = createNamModelRecord('fuzz-war-nam', parseNamModel(modelJson(), 'Fuzz War.nam'), 1234);

  await repository.save(record);
  assert.deepEqual(await repository.get('fuzz-war-nam'), record);
  assert.deepEqual(await repository.list(), [record]);

  await repository.remove('fuzz-war-nam');
  assert.equal(await repository.get('fuzz-war-nam'), null);
});
