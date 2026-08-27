import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const wasmUrl = new URL('../../public/audio/pedalkernel.wasm', import.meta.url);

const MODELS = [
  { name: 'MXR Dyna Comp', controls: [0.46, 0.58], definingControl: 1 },
  { name: 'Boss BD-2 Blues Driver', controls: [0.38, 0.54, 0.58], definingControl: 2 },
  { name: 'Pro Co RAT 2', controls: [0.56, 0.45, 0.62], definingControl: 0 },
  { name: 'Electro-Harmonix Big Muff Pi', controls: [0.67, 0.43, 0.58], definingControl: 2 },
  { name: 'Boss DM-2 Delay', controls: [0.4, 0.35, 0.4], definingControl: 2 },
  { name: 'Electro-Harmonix Deluxe Memory Man', controls: [0.4, 0.4, 0.5], definingControl: 2 },
  { name: 'Dallas-Arbiter Fuzz Face', controls: [0.7, 0.6], definingControl: 1 },
  { name: 'Boss CE-2 Chorus', controls: [0.4, 0.5], definingControl: 1 },
  { name: 'Fulltone OCD', controls: [0.5, 0.5, 0.7], definingControl: 2 },
  { name: 'Klon Centaur', controls: [0.5, 0.5, 0.7], definingControl: 2 },
  { name: 'Boss SD-1 Super OverDrive', controls: [0.5, 0.5, 0.7], definingControl: 2 },
  { name: 'Ibanez TS808 Tube Screamer', controls: [0.5, 0.5, 0.7], definingControl: 2 },
  { name: 'MXR Phase 90', controls: [0.5], definingControl: 0 },
];

test('ships the PedalKernel circuit runtime as browser WebAssembly', async () => {
  assert.ok(existsSync(wasmUrl), 'PedalKernel WASM artifact is missing');
  const wasmModule = await WebAssembly.compile(readFileSync(wasmUrl));
  const exports = WebAssembly.Module.exports(wasmModule).map((entry) => entry.name);
  for (const name of ['memory', 'init_model', 'set_control', 'resize_buffer', 'buffer_ptr', 'process_block']) {
    assert.ok(exports.includes(name), `missing WASM export: ${name}`);
  }
});

test('publishes the PedalKernel runtime ABI used for cache compatibility', async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmUrl), {});
  const exports = instance.exports as unknown as { runtime_version?: () => number };

  assert.equal(typeof exports.runtime_version, 'function');
  assert.equal(exports.runtime_version?.(), 3);
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

test('every upstream circuit initializes and stays audible and bounded after calibration', async () => {
  const bytes = readFileSync(wasmUrl);

  for (let modelId = 0; modelId < MODELS.length; modelId += 1) {
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
    assert.equal(exports.resize_buffer(44_100), 1);
    const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 44_100);
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
    MODELS[modelId].controls.forEach((value, controlId) => exports.set_control(controlId, value));
    assert.equal(exports.process_block(buffer.length), 1);
    const peak = buffer.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
    const tail = buffer.subarray(buffer.length - 4096);
    const rms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);
    assert.ok(buffer.every(Number.isFinite), `${MODELS[modelId].name} emitted non-finite audio`);
    assert.ok(rms > 0.002, `${MODELS[modelId].name} lost sustained output (${rms})`);
    assert.ok(peak <= 1.05, `${MODELS[modelId].name} exceeded calibrated bounds (${peak})`);
  }
});

test('Dyna Comp keeps a usable default output level', async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmUrl), {});
  const exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    init_model: (id: number, sampleRate: number) => number;
    set_control: (id: number, value: number) => number;
    resize_buffer: (length: number) => number;
    buffer_ptr: () => number;
    process_block: (length: number) => number;
  };
  const length = 22_050;
  const inputRms = 0.08 / Math.sqrt(2);
  assert.equal(exports.init_model(0, 44_100), 1);
  assert.equal(exports.resize_buffer(length), 1);
  const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), length);
  for (let index = 0; index < length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
  MODELS[0].controls.forEach((value, controlId) => exports.set_control(controlId, value));
  assert.equal(exports.process_block(length), 1);
  const tail = buffer.subarray(4096);
  const outputRms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);

  assert.ok(outputRms >= inputRms * 0.5, `Dyna Comp default output is too quiet (${outputRms})`);
  assert.ok(outputRms <= inputRms * 2, `Dyna Comp default output has unsafe make-up gain (${outputRms})`);
});

test('default compressor and fuzz levels stay near the clean reference', async () => {
  const bytes = readFileSync(wasmUrl);
  const inputRms = 0.08 / Math.sqrt(2);
  for (const modelId of [0, 3, 6]) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      init_model: (id: number, sampleRate: number) => number;
      set_control: (id: number, value: number) => number;
      resize_buffer: (length: number) => number;
      buffer_ptr: () => number;
      process_block: (length: number) => number;
    };
    const length = 22_050;
    assert.equal(exports.init_model(modelId, 44_100), 1);
    assert.equal(exports.resize_buffer(length), 1);
    const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), length);
    for (let index = 0; index < length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
    MODELS[modelId].controls.forEach((value, controlId) => exports.set_control(controlId, value));
    assert.equal(exports.process_block(length), 1);
    const tail = buffer.subarray(4096);
    const outputRms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);
    assert.ok(outputRms >= inputRms * 0.5, `${MODELS[modelId].name} default output is too quiet (${outputRms})`);
    assert.ok(outputRms <= inputRms * 2, `${MODELS[modelId].name} default output is too loud (${outputRms})`);
  }
});

test('Big Muff and Fuzz Face fit the AudioWorklet processing budget', async () => {
  const bytes = readFileSync(wasmUrl);
  const renderTime = async (modelId: number) => {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      init_model: (id: number, sampleRate: number) => number;
      set_control: (id: number, value: number) => number;
      resize_buffer: (length: number) => number;
      buffer_ptr: () => number;
      process_block: (length: number) => number;
    };
    const render = (length: number) => {
      assert.equal(exports.resize_buffer(length), 1);
      const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), length);
      for (let index = 0; index < length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
      const startedAt = performance.now();
      assert.equal(exports.process_block(length), 1);
      return performance.now() - startedAt;
    };
    assert.equal(exports.init_model(modelId, 44_100), 1);
    MODELS[modelId].controls.forEach((value, controlId) => exports.set_control(controlId, value));
    render(512);
    return render(4096);
  };

  const dynaMs = await renderTime(0);
  const maximumHeavyModelMs = dynaMs * 4 + 10;
  for (const modelId of [3, 6]) {
    const elapsedMs = await renderTime(modelId);
    assert.ok(elapsedMs <= maximumHeavyModelMs, `${MODELS[modelId].name} blocks the audio thread (${elapsedMs.toFixed(1)} ms vs ${maximumHeavyModelMs.toFixed(1)} ms)`);
  }
});

test('every exposed upstream control changes its circuit output', async () => {
  const bytes = readFileSync(wasmUrl);
  for (let modelId = 0; modelId < MODELS.length; modelId += 1) {
    const render = async (changedControl: number | null, value = 0) => {
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
      assert.equal(exports.resize_buffer(22_050), 1);
      const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), 22_050);
      for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.sin(index * 0.071) * 0.08;
      MODELS[modelId].controls.forEach((defaultValue, controlId) => exports.set_control(controlId, controlId === changedControl ? value : defaultValue));
      assert.equal(exports.process_block(buffer.length), 1);
      return Float32Array.from(buffer.subarray(4096));
    };
    const baseline = await render(null);
    for (let controlId = 0; controlId < MODELS[modelId].controls.length; controlId += 1) {
      const defaultValue = MODELS[modelId].controls[controlId];
      const changed = await render(controlId, defaultValue < 0.5 ? 0.85 : 0.15);
      const difference = changed.reduce((sum, sample, index) => sum + Math.abs(sample - baseline[index]), 0) / changed.length;
      assert.ok(difference > 1e-5, `${MODELS[modelId].name} control ${controlId} did not change its output (${difference})`);
    }
  }
});
