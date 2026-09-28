// Realtime-factor benchmark of the circuit WASM, as the AudioWorklet runs it.
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? new URL('../target/wasm32-unknown-unknown/release/sonic_board_circuit.wasm', import.meta.url);
const { instance } = await WebAssembly.instantiate(readFileSync(path), {});
const w = instance.exports;
const rate = 48_000;
const count = w.model_count();
for (let model = 0; model < count; model += 1) {
  const len = w.model_info(model);
  const info = JSON.parse(new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.info_ptr(), len)));
  let t = performance.now();
  const handle = w.create(model, rate);
  const createMs = performance.now() - t;
  if (!handle) throw new Error(`create failed for ${info.id}`);
  const seconds = 3;
  let phase = 0;
  t = performance.now();
  for (let block = 0; block < (rate * seconds) / 128; block += 1) {
    const buf = new Float32Array(w.memory.buffer, w.buffer_ptr(handle, 128), 128);
    for (let i = 0; i < 128; i += 1) {
      const time = phase / rate;
      buf[i] = 0.4 * Math.exp(-3 * (time % 1)) * (Math.sin(2 * Math.PI * 110 * time) + 0.5 * Math.sin(2 * Math.PI * 164.8 * time));
      phase += 1;
    }
    w.process(handle, 128);
  }
  const elapsed = (performance.now() - t) / 1000;
  console.log(`${info.name}: ${(seconds / elapsed).toFixed(1)}x realtime (os ${info.oversample}x), create ${createMs.toFixed(1)} ms, failures ${w.failures(handle)}`);
  w.destroy(handle);
}
