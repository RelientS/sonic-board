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
  assert.equal(w.runtime_version(), 6);
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

test('Phase 90: the internal LFO sweeps the notches and the script switch opens the feedback', async () => {
  const w = await load();
  const model = Array.from({ length: w.model_count() }, (_, index) => index).find((index) => info(w, index).id === 'mxr-phase90');
  assert.ok(model !== undefined, 'mxr-phase90 is bundled');
  const meta = info(w, model);
  assert.deepEqual(meta.controls.map((control) => control.label), ['Speed']);
  assert.deepEqual(meta.switches.map((sw) => sw.label), ['Script']);
  const tone = (handle: number, seconds: number) => {
    const out: number[] = [];
    let n = 0;
    for (let block = 0; block < (seconds * 48_000) / 128; block += 1) {
      const buf = new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128);
      for (let i = 0; i < 128; i += 1, n += 1) buf[i] = 0.2 * Math.sin((2 * Math.PI * 700 * n) / 48_000);
      w.process(handle, 128);
      out.push(...new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128));
    }
    return out;
  };
  const windows = (out: number[]) => {
    const levels: number[] = [];
    for (let start = 4_800; start + 480 <= out.length; start += 480) levels.push(20 * Math.log10(rms(out.slice(start, start + 480))));
    return levels;
  };
  // Fast speed: several sweeps a second move the notches across 700 Hz.
  const fast = w.create(model, 48_000);
  w.set_control(fast, 0, 0.9);
  const levels = windows(tone(fast, 1.2));
  const swing = Math.max(...levels) - Math.min(...levels);
  assert.ok(swing > 6, `sweep only modulates a 700 Hz tone by ${swing.toFixed(1)} dB`);
  assert.equal(w.failures(fast), 0);
  w.destroy(fast);
  // Script (default) vs block-logo feedback: different notch depth.
  const script = w.create(model, 48_000);
  const block = w.create(model, 48_000);
  w.set_switch(block, 0, 0);
  const a = tone(script, 0.3);
  const b = tone(block, 0.3);
  const difference = rms(a.map((x, i) => x - b[i])) / Math.max(rms(a), rms(b));
  assert.ok(difference > 0.05, `script switch barely changes the output (${difference})`);
  w.destroy(script);
  w.destroy(block);
});

test('Dyna Comp: the envelope follower compresses loud input and Sensitivity lowers the threshold', async () => {
  const w = await load();
  const model = Array.from({ length: w.model_count() }, (_, index) => index).find((index) => info(w, index).id === 'mxr-dynacomp');
  assert.ok(model !== undefined, 'mxr-dynacomp is bundled');
  assert.deepEqual(info(w, model).controls.map((control) => control.label), ['Output', 'Sensitivity']);
  // Output level (dB re 1 V) of a steady 330 Hz tone once the envelope has settled.
  const settledDb = (amplitude: number, sensitivity: number) => {
    const handle = w.create(model, 48_000);
    w.set_control(handle, 0, 1);
    w.set_control(handle, 1, sensitivity);
    const out: number[] = [];
    let n = 0;
    for (let block = 0; block < 48_000 / 128; block += 1) {
      const buf = new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128);
      for (let i = 0; i < 128; i += 1, n += 1) buf[i] = amplitude * Math.sin((2 * Math.PI * 330 * n) / 48_000);
      w.process(handle, 128);
      if (block >= 300) out.push(...new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128));
    }
    assert.equal(w.failures(handle), 0);
    w.destroy(handle);
    return 20 * Math.log10(rms(out));
  };
  // ngspice-validated curve: +29.5 dB more input gives ~14 dB more output.
  const quiet = settledDb(0.01, 0.5);
  const loud = settledDb(0.3, 0.5);
  assert.ok(loud - quiet > 5 && loud - quiet < 18, `29.5 dB of input maps to ${(loud - quiet).toFixed(1)} dB of output`);
  const sensitive = settledDb(0.01, 1);
  const insensitive = settledDb(0.01, 0);
  assert.ok(sensitive - insensitive > 12, `Sensitivity only adds ${(sensitive - insensitive).toFixed(1)} dB of gain to quiet notes`);
});

test('CE-2: the bucket brigade delays the wet path ~4.7 ms and the LFO sweeps the delay', async () => {
  const w = await load();
  const model = Array.from({ length: w.model_count() }, (_, index) => index).find((index) => info(w, index).id === 'boss-ce2');
  assert.ok(model !== undefined, 'boss-ce2 is bundled');
  assert.deepEqual(info(w, model).controls.map((control) => control.label), ['Rate', 'Depth']);
  // Clicks every 70 ms; the wet echo is the largest peak 2-10 ms after each.
  const echoLagsMs = (rate: number, depth: number) => {
    const handle = w.create(model, 48_000);
    w.set_control(handle, 0, rate);
    w.set_control(handle, 1, depth);
    const period = 3_360;
    const out: number[] = [];
    let n = 0;
    for (let block = 0; block < (48_000 * 0.8) / 128; block += 1) {
      const buf = new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128);
      for (let i = 0; i < 128; i += 1, n += 1) buf[i] = n >= 9_600 && n % period === 0 ? 0.5 : 0;
      w.process(handle, 128);
      out.push(...new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128));
    }
    assert.equal(w.failures(handle), 0);
    w.destroy(handle);
    const lags: number[] = [];
    for (let click = 9_600 + ((period - (9_600 % period)) % period); click + 480 < out.length; click += period) {
      let best = click + 96;
      for (let k = click + 96; k < click + 480; k += 1) if (Math.abs(out[k]) > Math.abs(out[best])) best = k;
      lags.push(((best - click) / 48_000) * 1_000);
    }
    return lags;
  };
  const still = echoLagsMs(0.5, 0);
  assert.ok(still.every((lag) => lag > 4.3 && lag < 5.4), `echo lags at depth 0: ${still.map((l) => l.toFixed(2)).join(', ')} ms`);
  assert.ok(Math.max(...still) - Math.min(...still) < 0.1, 'depth 0 barely moves the delay');
  const swept = echoLagsMs(1, 1);
  const spread = Math.max(...swept) - Math.min(...swept);
  assert.ok(spread > 0.8 && spread < 2, `full depth sweeps the delay by ${spread.toFixed(2)} ms`);
});
