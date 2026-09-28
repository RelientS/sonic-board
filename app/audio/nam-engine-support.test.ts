import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { EFFECT_SPECS, mapControlValue } from '../effects/catalog.ts';

const engineUrl = new URL('./audio-engine.ts', import.meta.url);
const workletUrl = new URL('../../public/audio/nam-processor.js', import.meta.url);
const syncScriptUrl = new URL('../../scripts/sync-nam-wasm.mjs', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);

test('offers Fuzz War as a local NAM capture slot with honest fixed-capture controls', () => {
  const spec = EFFECT_SPECS.find((effect) => effect.id === 'fuzz-war-nam');
  assert.ok(spec, 'Fuzz War NAM pedal is missing');
  assert.equal(spec.nam?.slotId, 'fuzz-war-nam');
  assert.match(spec.nam?.sourceUrl ?? '', /tone3000\.com\/tones\/fuzz-war/i);
  assert.deepEqual(spec.controls.map((control) => control.id), ['input', 'output', 'mix']);
  const output = spec.controls.find((control) => control.id === 'output')!;
  assert.ok(Math.abs(mapControlValue(output, output.defaultValue)) < 0.25, 'fixed captures should default to unity output');
  assert.match(spec.description, /固定|capture|NAM/i);
});

test('preloads private NAM models before both live playback and offline export', () => {
  const engine = readFileSync(engineUrl, 'utf8');
  assert.match(engine, /export const NAM_EFFECT_IDS/);
  assert.match(engine, /prepareNamProcessor/);
  assert.match(engine, /prepareNamNodes/);
  // Live playback reuses loaded NAM nodes across rebuilds via the session cache.
  assert.match(engine, /await prepareNamNodes\(context, config, session\.namCache\)/);
  assert.match(engine, /await prepareNamNodes\(session\.context, config, session\.namCache\)/);
  assert.match(engine, /await prepareNamNodes\(offline, config\)/);
  assert.match(engine, /modelJson/);
  assert.match(engine, /disposeNamNodes/);
});

test('ships a fail-safe stereo NAM AudioWorklet and derives runtime assets from the MIT package', () => {
  assert.ok(existsSync(workletUrl), 'NAM AudioWorklet is missing');
  assert.ok(existsSync(syncScriptUrl), 'NAM runtime sync script is missing');
  const worklet = readFileSync(workletUrl, 'utf8');
  const engine = readFileSync(engineUrl, 'utf8');
  const packageJson = JSON.parse(readFileSync(packageUrl, 'utf8')) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };

  assert.match(packageJson.dependencies?.['@opendaw/nam-wasm'] ?? '', /^\^?1\./);
  assert.match(packageJson.scripts?.prebuild ?? '', /sync-nam-wasm/);
  assert.match(worklet, /registerProcessor\('sonic-nam'/);
  assert.match(worklet, /NamWasmModule/);
  assert.match(engine, /WebAssembly\.compile/);
  assert.match(engine, /wasmModule/);
  assert.match(worklet, /new WebAssembly\.Instance\(wasmModule/);
  assert.match(worklet, /locateFile/, 'AudioWorklet has no URL global, so Emscripten must not resolve the WASM URL itself');
  assert.match(worklet, /model-loaded/);
  assert.match(worklet, /inputChannels\[channel\] \?\? inputChannels\[0\]/);
  assert.match(worklet, /Number\.isFinite/);
  assert.match(worklet, /destination\.set\(source\)/, 'model failure must remain audible as passthrough');
});
