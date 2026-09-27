import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const wasmUrl = new URL('../../public/audio/circuit.wasm', import.meta.url);

type CircuitExports = {
  memory: WebAssembly.Memory;
  runtime_version: () => number;
  model_count: () => number;
  model_info: (model: number) => number;
  info_ptr: () => number;
  create: (model: number, sampleRate: number) => number;
  destroy: (handle: number) => void;
  set_control: (handle: number, index: number, value: number) => number;
  set_switch: (handle: number, index: number, value: number) => number;
  buffer_ptr: (handle: number, length: number) => number;
  process: (handle: number, length: number) => number;
  failures: (handle: number) => number;
};

type ModelInfo = { id: string; name: string; oversample: number; controls: Array<{ label: string; default: number }>; switches: Array<{ label: string }> };

let wasmModulePromise: Promise<WebAssembly.Module> | undefined;

async function load() {
  wasmModulePromise ??= WebAssembly.compile(readFileSync(wasmUrl));
  const instance = await WebAssembly.instantiate(await wasmModulePromise, {});
  return instance.exports as unknown as CircuitExports;
}

function info(w: CircuitExports, model: number): ModelInfo {
  const length = w.model_info(model);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.info_ptr(), length)));
}

// Plucked two-note DI-like test signal peaking near -8 dBFS.
function render(w: CircuitExports, handle: number, seconds = 0.5, rate = 48_000) {
  const out: number[] = [];
  let n = 0;
  for (let block = 0; block < (seconds * rate) / 128; block += 1) {
    const buf = new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128);
    for (let i = 0; i < 128; i += 1, n += 1) {
      const t = n / rate;
      buf[i] = 0.25 * Math.exp(-4 * t) * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 165 * t));
    }
    assert.equal(w.process(handle, 128), 1);
    out.push(...new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128));
  }
  return out;
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((sum, x) => sum + x * x, 0) / xs.length);

test('ships the circuit runtime with its model table', async () => {
  assert.ok(existsSync(wasmUrl), 'circuit.wasm is missing; run npm run build:circuit');
  const w = await load();
  assert.equal(w.runtime_version(), 2);
  assert.ok(w.model_count() >= 1);
  const ids = Array.from({ length: w.model_count() }, (_, model) => info(w, model).id);
  assert.ok(ids.includes('rams-head-muff'));
});

test('every circuit model initializes, stays finite and bounded, and converges', async () => {
  const w = await load();
  for (let model = 0; model < w.model_count(); model += 1) {
    const meta = info(w, model);
    const handle = w.create(model, 48_000);
    assert.ok(handle > 0, `${meta.id} failed to initialize`);
    const out = render(w, handle);
    assert.ok(out.every(Number.isFinite), `${meta.id} produced non-finite samples`);
    const peak = Math.max(...out.map(Math.abs));
    const level = 20 * Math.log10(rms(out.slice(2_400)));
    assert.ok(peak < 4, `${meta.id} peak ${peak}`);
    assert.ok(level > -40 && level < 6, `${meta.id} default level ${level.toFixed(1)} dBFS`);
    assert.equal(w.failures(handle), 0, `${meta.id} Newton failures`);
    w.destroy(handle);
  }
});

test('every circuit control changes the sound', async () => {
  const w = await load();
  for (let model = 0; model < w.model_count(); model += 1) {
    const meta = info(w, model);
    meta.controls.forEach((control, index) => {
      const low = w.create(model, 48_000);
      const high = w.create(model, 48_000);
      w.set_control(low, index, 0.15);
      w.set_control(high, index, 0.95);
      const a = render(w, low, 0.25);
      const b = render(w, high, 0.25);
      const difference = rms(a.map((x, i) => x - b[i])) / Math.max(rms(a), rms(b));
      assert.ok(difference > 0.02, `${meta.id} ${control.label} barely changes the output (${difference})`);
      w.destroy(low);
      w.destroy(high);
    });
  }
});
