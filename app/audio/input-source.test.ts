import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_INPUT_SETTINGS,
  dragLoop,
  effectiveLoop,
  inputLevelVerdict,
  loopPosition,
  MIN_LOOP_SECONDS,
  normalizeInputSettings,
  normalizeSourceConfig,
  positionInLoop,
  trimDbToGain,
} from './source-catalog.ts';
import { cleanTakeName, createMemoryTakeStorage, makeRecordedTake, makeTakeId, MAX_RECORDING_SECONDS, mixToMono } from './takes-store.ts';
import { computePeaks, peakDbfs, peakScale } from './waveform.ts';
import { currentSourcePosition, sourceKeyOf, type LiveAudioSession } from './audio-engine.ts';
import { boardFromPreset, boardReducer, undoKeyFor } from '../studio/board-store.ts';
import { FACTORY_PRESETS, instantiatePreset } from '../effects/catalog.ts';
import { captureUserPreset, instantiateUserPreset, parseUserPresets } from '../effects/user-presets.ts';

test('older boards and presets without input settings still parse', () => {
  assert.deepEqual(normalizeInputSettings(undefined), DEFAULT_INPUT_SETTINGS);
  assert.deepEqual(normalizeInputSettings({ takeId: '../etc', loop: { start: 2, end: 1 }, trimDb: 40 }), { takeId: null, loop: null, trimDb: 12 });
  assert.deepEqual(normalizeInputSettings({ takeId: 'take-abc-0001', loop: { start: 1, end: 3 }, trimDb: -3.14 }), {
    takeId: 'take-abc-0001', loop: { start: 1, end: 3 }, trimDb: -3.1,
  });
  // The example phrase keeps its old shape (and its old string form).
  assert.deepEqual(normalizeSourceConfig('lead'), { guitar: 'single-neck', performance: 'lead', progression: 'dream-open' });
});

test('input trim maps dB to gain and clamps to ±12 dB', () => {
  assert.equal(trimDbToGain(0), 1);
  assert.ok(Math.abs(trimDbToGain(6) - 1.9953) < 1e-3);
  assert.ok(Math.abs(trimDbToGain(-40) - trimDbToGain(-12)) < 1e-12);
  assert.equal(trimDbToGain(Number.NaN), 1);
});

test('loops are clamped into the source and never shorter than the minimum', () => {
  assert.deepEqual(effectiveLoop(null, 6.4), { start: 0, end: 6.4 });
  assert.deepEqual(effectiveLoop({ start: 2, end: 3 }, 6.4), { start: 2, end: 3 });
  assert.deepEqual(effectiveLoop({ start: 5, end: 99 }, 6.4), { start: 5, end: 6.4 });
  assert.deepEqual(effectiveLoop({ start: 3, end: 3.01 }, 6.4), { start: 3, end: 3 + MIN_LOOP_SECONDS });
  assert.deepEqual(effectiveLoop({ start: 6.39, end: 6.4 }, 6.4), { start: 6.4 - MIN_LOOP_SECONDS, end: 6.4 });
  assert.deepEqual(effectiveLoop({ start: 0, end: 6.4 }, 6.4), { start: 0, end: 6.4 });
  assert.deepEqual(effectiveLoop({ start: 1, end: 2 }, 0.1), { start: 0, end: 0.1 });
});

test('loop playhead math wraps inside the region', () => {
  const loop = { start: 2, end: 4 };
  assert.equal(loopPosition(loop, 0), 2);
  assert.equal(loopPosition(loop, 3), 3);
  assert.equal(loopPosition(loop, -0.5), 3.5);
  assert.equal(positionInLoop(loop, 3.2), 3.2);
  assert.equal(positionInLoop(loop, 5), 2);
  assert.equal(positionInLoop(loop, 1), 2);
});

test('dragging a loop edge or the region keeps it inside the source', () => {
  const loop = { start: 2, end: 4 };
  assert.deepEqual(dragLoop(loop, 'start', -0.5, 10), { start: 1.5, end: 4 });
  assert.deepEqual(dragLoop(loop, 'start', 5, 10), { start: 4 - MIN_LOOP_SECONDS, end: 4 });
  assert.deepEqual(dragLoop(loop, 'end', 1, 10), { start: 2, end: 5 });
  assert.deepEqual(dragLoop(loop, 'region', 10, 10), { start: 8, end: 10 });
  assert.deepEqual(dragLoop(loop, 'region', -10, 10), { start: 0, end: 2 });
  // Drawing a new loop starts from an empty region and drags its end.
  assert.deepEqual(dragLoop({ start: 3, end: 3 }, 'end', 1.2, 10), { start: 3, end: 4.2 });
});

test('the level verdict brackets a typical pickup level', () => {
  assert.equal(inputLevelVerdict(-40), '偏小');
  assert.equal(inputLevelVerdict(-12), '合适');
  assert.equal(inputLevelVerdict(-1), '偏大');
  assert.equal(inputLevelVerdict(Number.NEGATIVE_INFINITY), null);
});

test('waveform peaks are min/max per column and cached', () => {
  const signal = Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.5 : -0.25) * (i % 2 ? 1 : -1));
  const peaks = computePeaks(signal, 1000, 4);
  assert.equal(peaks.duration, 1);
  assert.deepEqual([...peaks.max], [0.5, 0.5, 0.25, 0.25]);
  assert.deepEqual([...peaks.min], [-0.5, -0.5, -0.25, -0.25]);
  assert.equal(computePeaks(signal, 1000, 4), peaks);
  assert.ok(Math.abs(peakScale(peaks) - 1.9) < 1e-6);
  assert.ok(Math.abs(peakDbfs(Float32Array.of(0.5, -0.1)) + 6.0206) < 1e-3);
});

test('takes keep their DI level in mono and stay in the take store', async () => {
  const left = Float32Array.from({ length: 48_000 * 3 }, () => 0.2);
  const right = Float32Array.from({ length: 48_000 * 3 }, () => 0.4);
  const mono = mixToMono([left, right], 48_000, 2);
  assert.equal(mono.length, 96_000);
  assert.ok(Math.abs(mono[10] - 0.3) < 1e-6);

  const storage = createMemoryTakeStorage();
  const long = new Float32Array(48_000 * (MAX_RECORDING_SECONDS + 5));
  const take = makeRecordedTake(long, 48_000, '  副歌   扫弦 ', 1_000);
  assert.equal(take.durationSeconds, MAX_RECORDING_SECONDS);
  assert.equal(take.name, '副歌 扫弦');
  await storage.put(take);
  await storage.put({ ...makeRecordedTake(new Float32Array(480), 48_000, '', 2_000), id: 'take-b' });
  assert.deepEqual((await storage.list()).map((entry) => entry.id), ['take-b', take.id]);
  assert.equal('channel' in (await storage.list())[0], false);
  assert.equal((await storage.get(take.id))?.channel.length, 48_000 * MAX_RECORDING_SECONDS);
  await storage.rename(take.id, '');
  assert.equal((await storage.list())[1].name, '副歌 扫弦');
  await storage.remove(take.id);
  assert.equal(await storage.get(take.id), null);
  assert.equal(cleanTakeName('   '), '未命名录音');
  assert.match(makeTakeId(0, () => 0.5), /^take-0-[0-9a-z]{4}$/);
});

test('choosing a take, looping and trimming are undoable board edits', () => {
  const preset = FACTORY_PRESETS[0];
  let state = boardFromPreset(instantiatePreset(preset, 'input'), preset.name);
  assert.deepEqual(state.input, DEFAULT_INPUT_SETTINGS);
  state = boardReducer(state, { type: 'setInput', input: { takeId: 'take-a' } });
  assert.equal(state.input.takeId, 'take-a');
  state = boardReducer(state, { type: 'setInput', input: { loop: { start: 1, end: 2 } } });
  assert.deepEqual(state.input.loop, { start: 1, end: 2 });
  // No-op edits return the same state.
  assert.equal(boardReducer(state, { type: 'setInput', input: { loop: { start: 1, end: 2 } } }), state);
  // Picking an example phrase stops the take and drops its loop.
  const example = boardReducer(state, { type: 'setSource', source: { ...state.source, performance: 'lead' } });
  assert.deepEqual(example.input, { takeId: null, loop: null, trimDb: 0 });
  assert.equal(undoKeyFor({ type: 'setInput', input: { takeId: 'x' } }), 'discrete');
  // One loop-handle drag or one trim drag coalesces into one undo step.
  assert.equal(undoKeyFor({ type: 'setInput', input: { loop: null } }), 'input:loop');
  assert.equal(undoKeyFor({ type: 'setInput', input: { trimDb: 3 } }), 'input:trimDb');
});

test('user presets remember the take id, loop and trim but never the audio', () => {
  const preset = FACTORY_PRESETS[0];
  const board = boardFromPreset(instantiatePreset(preset, 'save'), preset.name);
  const input = { takeId: 'take-a', loop: { start: 0.5, end: 2 }, trimDb: -4 };
  const captured = captureUserPreset({ name: 'x', chain: board.chain, values: board.snapshots.A, bypassed: board.bypassed, source: board.source, input, output: board.output, routing: board.routing, amp: board.amp });
  const [parsed] = parseUserPresets(JSON.stringify([captured]));
  assert.deepEqual(parsed.input, input);
  assert.deepEqual(instantiateUserPreset(parsed).input, input);
  assert.equal(JSON.stringify(captured).includes('channel'), false);
  // Presets saved before takes existed load with the default input.
  const legacy = { ...captured };
  delete legacy.input;
  assert.deepEqual(instantiateUserPreset(parseUserPresets(JSON.stringify([legacy]))[0]).input, DEFAULT_INPUT_SETTINGS);
});

test('the playhead is an absolute position in the source, wrapping inside the loop', () => {
  const session = { context: { state: 'running', currentTime: 10 }, startedAt: 7, duration: 2, loopStart: 1 } as unknown as LiveAudioSession;
  assert.equal(currentSourcePosition(session), 2);
  assert.equal(currentSourcePosition({ ...session, context: { state: 'closed', currentTime: 10 } } as unknown as LiveAudioSession), null);
  assert.equal(currentSourcePosition(null), null);
});

test('a take and an example phrase are different sources to the engine', () => {
  const source = normalizeSourceConfig(undefined);
  const take = { id: 'take-a', sampleRate: 48_000, channel: new Float32Array(10) };
  assert.equal(sourceKeyOf({ source }), 'single-neck:chords:dream-open');
  assert.equal(sourceKeyOf({ source, input: { trimDb: 0, loop: null, take } }), 'take:take-a:10');
  // Loop and trim are applied in place: they are not part of the source key.
  assert.equal(sourceKeyOf({ source, input: { trimDb: 6, loop: { start: 1, end: 2 } } }), sourceKeyOf({ source }));
});
