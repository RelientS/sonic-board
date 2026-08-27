import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const wasmUrl = new URL('../../public/audio/pedalkernel.wasm', import.meta.url);

test('ships the PedalKernel circuit runtime as browser WebAssembly', async () => {
  assert.ok(existsSync(wasmUrl), 'PedalKernel WASM artifact is missing');
  const wasmModule = await WebAssembly.compile(readFileSync(wasmUrl));
  const exports = WebAssembly.Module.exports(wasmModule).map((entry) => entry.name);
  for (const name of ['memory', 'init_model', 'set_control', 'resize_buffer', 'buffer_ptr', 'process_block']) {
    assert.ok(exports.includes(name), `missing WASM export: ${name}`);
  }
});

test('PedalKernel processes a block and responds to pedal controls', async () => {
  assert.ok(existsSync(wasmUrl), 'PedalKernel WASM artifact is missing');
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmUrl), {});
  const exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    init_model: (modelId: number, sampleRate: number) => number;
    set_control: (controlId: number, value: number) => number;
    resize_buffer: (length: number) => number;
    buffer_ptr: () => number;
    process_block: (length: number) => number;
  };

  assert.equal(exports.init_model(2, 44_100), 1, 'RAT model should initialize');
  assert.equal(exports.resize_buffer(512), 1);
  const input = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 512);
  for (let index = 0; index < input.length; index += 1) input[index] = Math.sin(index * 0.17) * 0.08;
  assert.equal(exports.set_control(0, 0.2), 1);
  assert.equal(exports.process_block(input.length), 1);
  const lowDrive = Float32Array.from(input);

  assert.equal(exports.init_model(2, 44_100), 1);
  assert.equal(exports.resize_buffer(512), 1);
  const driven = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 512);
  for (let index = 0; index < driven.length; index += 1) driven[index] = Math.sin(index * 0.17) * 0.08;
  assert.equal(exports.set_control(0, 0.9), 1);
  assert.equal(exports.process_block(driven.length), 1);

  assert.ok(driven.every(Number.isFinite), 'PedalKernel output must remain finite');
  const difference = driven.reduce((sum, sample, index) => sum + Math.abs(sample - lowDrive[index]), 0);
  assert.ok(difference > 0.001, 'Distortion control should alter the rendered signal');
});

test('every shipped circuit stays bounded for a calibrated DI input', async () => {
  const bytes = readFileSync(wasmUrl);
  const defaultControls = [
    [0.46, 0.58],
    [0.38, 0.54, 0.58],
    [0.56, 0.45, 0.62],
    [0.67, 0.43, 0.58],
  ];

  for (let modelId = 0; modelId < defaultControls.length; modelId += 1) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      init_model: (id: number, sampleRate: number) => number;
      set_control: (id: number, value: number) => number;
      resize_buffer: (length: number) => number;
      buffer_ptr: () => number;
      process_block: (length: number) => number;
    };
    assert.equal(exports.init_model(modelId, 44_100), 1);
    assert.equal(exports.resize_buffer(12_000), 1);
    const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 12_000);
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
    defaultControls[modelId].forEach((value, controlId) => exports.set_control(controlId, value));
    assert.equal(exports.process_block(buffer.length), 1);
    const peak = buffer.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
    assert.ok(buffer.every(Number.isFinite), `model ${modelId} emitted non-finite audio`);
    assert.ok(peak > 1e-7, `model ${modelId} became silent`);
    assert.ok(peak < 8, `model ${modelId} diverged to ${peak}`);
  }
});

test('runtime-enabled circuits preserve sustained guitar signal', async () => {
  const bytes = readFileSync(wasmUrl);
  const runtimeModels = [
    { modelId: 0, controls: [0.46, 0.58], name: 'MXR Dyna Comp' },
    { modelId: 2, controls: [0.56, 0.45, 0.62], name: 'Pro Co RAT 2' },
  ];

  for (const model of runtimeModels) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      init_model: (id: number, sampleRate: number) => number;
      set_control: (id: number, value: number) => number;
      resize_buffer: (length: number) => number;
      buffer_ptr: () => number;
      process_block: (length: number) => number;
    };
    assert.equal(exports.init_model(model.modelId, 44_100), 1);
    assert.equal(exports.resize_buffer(44_100), 1);
    const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 44_100);
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.sin(index * 0.071) * 0.08;
    }
    model.controls.forEach((value, controlId) => exports.set_control(controlId, value));
    assert.equal(exports.process_block(buffer.length), 1);

    const tail = buffer.subarray(buffer.length - 4096);
    const rms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);
    assert.ok(rms > 1e-5, `${model.name} lost its sustained output (${rms})`);
  }
});
