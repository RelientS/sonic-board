// Real-time cost matrix for every circuit model, through the real worklet
// (public/audio/circuit-processor.js) and the WASM runtime, outside the
// browser. For each model: input amplitudes 0.3/1/2/4 x knobs all-mid, all-0,
// all-1, a 2 s decaying chord in 128-sample quanta. Each quantum's time is
// the fastest of REPEATS identical runs (the run is deterministic), so
// scheduler noise does not show up as a spike.
//
//   node bench/worklet-matrix.mjs <circuit.wasm> <circuit-processor.js> [modelIndex ...]
//   env: EXPECT (runtime version, default 7), REPEATS (default 3)
import { readFileSync } from 'node:fs';

const [wasmPath, processorPath, ...only] = process.argv.slice(2);
const expected = Number(process.env.EXPECT ?? 7);
const repeats = Number(process.env.REPEATS ?? 3);
const registered = {};
globalThis.sampleRate = 48_000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
await import(processorPath);
const wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
const Processor = registered['sonic-circuit'];
const probe = new WebAssembly.Instance(wasmModule, { env: new Proxy({}, { get: () => () => 0 }) }).exports;
const count = probe.model_count();
const models = only.length ? only.map(Number) : [...Array(count).keys()];
const blocks = (2 * 48_000) / 128;

function run(modelIndex, amp, knob) {
  const controls = Array(6).fill(knob);
  const times = new Float64Array(blocks).fill(Infinity);
  let level = 0;
  for (let rep = 0; rep < repeats; rep += 1) {
    const stage = new Processor({ processorOptions: { wasmModule, expectedRuntimeVersion: expected, modelIndex, controls, switches: [] } });
    if (!stage.ready) throw new Error(`model ${modelIndex} not ready`);
    let n = 0;
    for (let block = 0; block < blocks; block += 1) {
      const mono = new Float32Array(128);
      for (let i = 0; i < 128; i += 1, n += 1) {
        const t = n / 48_000;
        mono[i] = amp * Math.exp(-2 * (t % 1)) * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 165 * t));
      }
      const output = [new Float32Array(128), new Float32Array(128)];
      const t0 = performance.now();
      stage.process([[mono, mono]], [output]);
      times[block] = Math.min(times[block], performance.now() - t0);
      if (rep === 0) level += output[0].reduce((s, x) => s + x * x, 0);
    }
  }
  const after = times.slice(1);
  return {
    mean: after.reduce((a, b) => a + b, 0) / after.length,
    worst: Math.max(...after),
    first: times[0],
    db: 10 * Math.log10(level / (blocks * 128) + 1e-20),
  };
}

const names = [];
for (let m = 0; m < count; m += 1) {
  const len = probe.model_info(m);
  const bytes = new Uint8Array(probe.memory.buffer, probe.info_ptr(), len);
  names.push(JSON.parse(new TextDecoder().decode(bytes)).id);
}
for (const m of models) {
  let worst = 0;
  let worstAt = '';
  let meanMax = 0;
  let quiet = [];
  for (const amp of [0.3, 1, 2, 4]) {
    for (const knob of [0.5, 0, 1]) {
      const r = run(m, amp, knob);
      if (r.worst > worst) {
        worst = r.worst;
        worstAt = `amp ${amp} knobs ${knob}`;
      }
      meanMax = Math.max(meanMax, r.mean);
      if (r.db < -60 && knob !== 0) quiet.push(`amp ${amp} knobs ${knob}: ${r.db.toFixed(0)} dBFS`);
    }
  }
  console.log(`${names[m].padEnd(16)} worst ${worst.toFixed(3)} ms (${worstAt}), highest mean ${meanMax.toFixed(3)} ms${quiet.length ? ' | QUIET ' + quiet.join('; ') : ''}`);
}
