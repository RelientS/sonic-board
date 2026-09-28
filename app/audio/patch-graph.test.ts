import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalCables,
  connect,
  deriveChain,
  disconnect,
  heal,
  INPUT_NODE,
  MIXER_NODE,
  OUTPUT_NODE,
  repatch,
  splice,
  SPLITTER_NODE,
  type Cable,
} from '../studio/patch-graph.ts';

const pedals = ['a', 'b', 'c', 'd'].map((id) => ({ instanceId: id, specId: `spec-${id}` }));
const serialNodes = new Set([INPUT_NODE, OUTPUT_NODE, 'a', 'b', 'c', 'd']);
const parallelNodes = new Set([...serialNodes, SPLITTER_NODE, MIXER_NODE]);
const chainOf = (...ids: string[]) => ids.map((id) => ({ instanceId: id, specId: `spec-${id}`, lane: 'A' as const }));

test('the chain is the cabled path from INPUT to OUTPUT; the rest is parked', () => {
  const cables = canonicalCables(chainOf('a', 'b', 'c'), 'serial');
  const derived = deriveChain(pedals, cables, 'serial');
  assert.deepEqual(derived.chain.map((item) => item.instanceId), ['a', 'b', 'c']);
  assert.deepEqual(derived.parked, ['d']);
  assert.equal(derived.broken, false);
  // Pull the plug out of b's input: a is still heard, b and c are parked, the path is broken.
  const unplugged = disconnect(cables, { node: 'b', port: 'in' });
  const after = deriveChain(pedals, unplugged, 'serial');
  assert.deepEqual(after.chain.map((item) => item.instanceId), ['a']);
  assert.deepEqual(after.parked, ['b', 'c', 'd']);
  assert.equal(after.broken, true);
});

test('connect accepts either jack order and refuses what the engine cannot run', () => {
  const context = { nodes: serialNodes, mode: 'serial' as const };
  const base = disconnect(canonicalCables(chainOf('a', 'b'), 'serial'), { node: OUTPUT_NODE, port: 'in' });
  // Sink first works too.
  const ok = connect(base, { node: OUTPUT_NODE, port: 'in' }, { node: 'b', port: 'out' }, context);
  assert.ok(ok.ok);
  assert.deepEqual(deriveChain(pedals, ok.ok ? ok.cables : [], 'serial').chain.map((item) => item.instanceId), ['a', 'b']);
  assert.deepEqual(connect(base, { node: 'a', port: 'in' }, { node: 'c', port: 'in' }, context), { ok: false, reason: 'same-direction' });
  assert.deepEqual(connect(base, { node: 'c', port: 'out' }, { node: 'c', port: 'in' }, context), { ok: false, reason: 'same-node' });
  assert.deepEqual(connect(base, { node: 'c', port: 'out' }, { node: 'b', port: 'in' }, context), { ok: false, reason: 'occupied' });
  // b -> a would close a loop (a already feeds b).
  const loopBase = disconnect(base, { node: 'a', port: 'in' });
  assert.deepEqual(connect(loopBase, { node: 'b', port: 'out' }, { node: 'a', port: 'in' }, context), { ok: false, reason: 'cycle' });
  assert.deepEqual(connect(base, { node: 'zz', port: 'out' }, { node: 'c', port: 'in' }, context), { ok: false, reason: 'unknown-node' });
});

test('parallel boards run INPUT -> splitter -> lanes -> mixer -> OUTPUT only', () => {
  const chain = [...chainOf('a', 'b'), { instanceId: 'c', specId: 'spec-c', lane: 'B' as const }];
  const cables = canonicalCables(chain, 'parallel');
  const derived = deriveChain(pedals, cables, 'parallel');
  assert.deepEqual(derived.chain.map((item) => `${item.instanceId}${item.lane}`), ['aA', 'bA', 'cB']);
  assert.equal(derived.broken, false);
  // An empty lane is a straight cable from the splitter to the mixer.
  const emptyB = canonicalCables(chainOf('a'), 'parallel');
  assert.ok(emptyB.some((cable) => cable.from.port === 'outB' && cable.to.node === MIXER_NODE && cable.to.port === 'inB'));
  const context = { nodes: parallelNodes, mode: 'parallel' as const };
  const free = disconnect(cables, { node: INPUT_NODE, port: 'out' });
  assert.deepEqual(connect(free, { node: INPUT_NODE, port: 'out' }, { node: 'd', port: 'in' }, context), { ok: false, reason: 'parallel-io' });
  assert.ok(connect(free, { node: INPUT_NODE, port: 'out' }, { node: SPLITTER_NODE, port: 'in' }, context).ok);
  const noOut = disconnect(cables, { node: OUTPUT_NODE, port: 'in' });
  assert.deepEqual(connect(noOut, { node: 'd', port: 'out' }, { node: OUTPUT_NODE, port: 'in' }, context), { ok: false, reason: 'parallel-io' });
  assert.equal(deriveChain(pedals, noOut, 'parallel').broken, true);
});

test('re-patching an order keeps a side chain among parked pedals', () => {
  const side: Cable = { from: { node: 'c', port: 'out' }, to: { node: 'd', port: 'in' } };
  const cables = [...canonicalCables(chainOf('a', 'b'), 'serial'), side];
  const next = repatch(cables, chainOf('b', 'a'), 'serial', ['c', 'd']);
  assert.deepEqual(deriveChain(pedals, next, 'serial').chain.map((item) => item.instanceId), ['b', 'a']);
  assert.ok(next.some((cable) => cable.from.node === 'c' && cable.to.node === 'd'));
});

test('splice inserts into a cable and heal closes the gap on removal', () => {
  const cables = canonicalCables(chainOf('a', 'b'), 'serial');
  const between = cables.find((cable) => cable.from.node === 'a' && cable.to.node === 'b')!;
  const spliced = splice(cables, between, 'c')!;
  assert.deepEqual(deriveChain(pedals, spliced, 'serial').chain.map((item) => item.instanceId), ['a', 'c', 'b']);
  // A pedal that already has cables cannot be spliced in again.
  assert.equal(splice(spliced, spliced[0], 'c'), null);
  const healed = heal(spliced, 'c');
  assert.deepEqual(deriveChain(pedals, healed, 'serial').chain.map((item) => item.instanceId), ['a', 'b']);
  assert.equal(deriveChain(pedals, healed, 'serial').broken, false);
});
