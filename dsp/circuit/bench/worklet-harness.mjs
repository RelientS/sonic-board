// Runs public/audio/circuit-processor.js outside the browser: a minimal
// AudioWorkletGlobalScope, a chain of processors, and per-stage levels plus
// the render-time budget used per 128-sample quantum.
import { readFileSync } from 'node:fs';

const [wasmPath, processorPath, ...chain] = process.argv.slice(2);
const registered = {};
globalThis.sampleRate = 48_000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
await import(processorPath);
const wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
const Processor = registered['sonic-circuit'];
const stages = chain.map((index) => new Processor({ processorOptions: { wasmModule, expectedRuntimeVersion: 4, modelIndex: Number(index), controls: [0.6, 0.5, 0.6], switches: [0] } }));
console.log('ready:', stages.map((s) => s.ready).join(', '));
const seconds = 2;
const levels = stages.map(() => 0);
let worst = 0;
let total = 0;
const slowest = [];
let n = 0;
for (let block = 0; block < (seconds * 48_000) / 128; block += 1) {
  const mono = new Float32Array(128);
  for (let i = 0; i < 128; i += 1, n += 1) {
    const t = n / 48_000;
    mono[i] = 0.3 * Math.exp(-2 * (t % 1)) * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 165 * t));
  }
  let input = [mono, mono];
  const t0 = performance.now();
  stages.forEach((stage, k) => {
    const output = [new Float32Array(128), new Float32Array(128)];
    stage.process([input], [output]);
    levels[k] += output[0].reduce((s, x) => s + x * x, 0);
    input = output;
  });
  const spent = performance.now() - t0;
  worst = Math.max(worst, spent);
  total += spent;
  slowest.push([spent, block]);
}
const budget = (128 / 48_000) * 1000;
slowest.sort((a, b) => b[0] - a[0]);
console.log('slowest quanta (ms@block):', slowest.slice(0, 6).map(([ms, b]) => `${ms.toFixed(2)}@${b}`).join(' '));
console.log('levels dBFS:', levels.map((e) => (10 * Math.log10(e / n)).toFixed(1)).join(', '));
console.log(`mean quantum ${(total / ((seconds * 48_000) / 128)).toFixed(3)} ms, worst ${worst.toFixed(3)} ms of ${budget.toFixed(3)} ms budget; still ready: ${stages.map((s) => s.ready).join(', ')}`);
