import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildToneAgentInput,
  normalizeRemoteTonePlan,
  parseResponsesText,
} from '../agent/tone-agent-api.ts';

test('agent prompt exposes the bounded catalog and requires strict JSON', () => {
  const input = buildToneAgentInput('宽阔的反向音墙');
  assert.match(input, /wall-fuzz/);
  assert.match(input, /reverse-space/);
  assert.match(input, /gpt-5\.6-terra/);
  assert.match(input, /只输出 JSON/);
  assert.match(input, /PedalKernel WDF/);
  assert.match(input, /phase90/);
  assert.doesNotMatch(input, /legacy-fallback/);
  assert.match(input, /verifiedScore[^}]*null/);
  assert.doesNotMatch(input, /sk-/);
});

test('responses text parser supports both compatible response shapes', () => {
  assert.equal(parseResponsesText({ output_text: '{"name":"A"}' }), '{"name":"A"}');
  assert.equal(parseResponsesText({
    output: [{ content: [{ type: 'output_text', text: '{"name":"B"}' }] }],
  }), '{"name":"B"}');
  assert.equal(parseResponsesText({ output: [] }), null);
});

test('remote plans are accepted only when every model and control is valid', () => {
  const valid = normalizeRemoteTonePlan({
    name: '云层音墙',
    summary: '反向混响进入法兹，再由双路延迟扩宽。',
    decisions: ['保留中频', '并联扩宽'],
    source: { guitar: 'humbucker', performance: 'chords', progression: 'dream-open' },
    routing: { mode: 'parallel', blend: 55, spread: 82 },
    amp: {
      ampId: 'brit-20', cabId: 'closed-4x12',
      ampValues: { gain: 31, mid: 66 }, cabValues: { room: 12 },
    },
    output: 64,
    chain: [
      { specId: 'reverse-space', lane: 'A', settings: { mix: 52, decay: 54 } },
      { specId: 'wall-fuzz', lane: 'B', settings: { sustain: 77, tone: 48 } },
      { specId: 'graphic-eq', lane: 'B', settings: { '800': 62 } },
    ],
  });
  assert.ok(valid);
  assert.equal(valid.preset.source.guitar, 'humbucker');
  assert.equal(valid.preset.chain.length, 3);
  assert.equal(valid.preset.amp.ampValues.mid, 66);

  assert.equal(normalizeRemoteTonePlan({
    ...valid,
    chain: [{ specId: 'not-a-pedal', settings: {} }, { specId: 'wall-fuzz' }, { specId: 'graphic-eq' }],
  }), null);
  assert.equal(normalizeRemoteTonePlan({
    name: 'bad', summary: 'bad', decisions: [],
    source: { guitar: 'humbucker', performance: 'chords', progression: 'dream-open' },
    routing: { mode: 'serial', blend: 50, spread: 0 },
    amp: { ampId: 'brit-20', cabId: 'closed-4x12', ampValues: {}, cabValues: {} },
    output: 64,
    chain: [{ specId: 'reverse-space', settings: { mix: 101 } }, { specId: 'wall-fuzz' }, { specId: 'graphic-eq' }],
  }), null);
});
