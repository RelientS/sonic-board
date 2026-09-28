import assert from 'node:assert/strict';
import test from 'node:test';

import { getEffectSpec } from '../effects/catalog.ts';
import {
  alignToGuides,
  autoLayout,
  boardSize,
  cablePath,
  footprintOf,
  FOOTPRINTS,
  GUIDE_TOLERANCE_MM,
  jackPoint,
  MIN_BOARD,
  nearestFreeSpot,
  plateRect,
  rectsOverlap,
  signalPoint,
  snap,
  viewRect,
  viewX,
} from '../studio/board-geometry.ts';
import { INPUT_NODE, MIXER_NODE, OUTPUT_NODE, SPLITTER_NODE } from '../studio/patch-graph.ts';

test('footprints are real enclosure sizes, with size classes as the fallback', () => {
  // MXR Custom Shop Dyna Comp: 2.67 x 4.5 in.
  assert.deepEqual(footprintOf('studio-comp'), { w: 68, h: 114.5 });
  // Boss compact: 2.875 x 5.125 in.
  assert.deepEqual(footprintOf('ds1-dist'), { w: 73, h: 130 });
  // Pedals without measurements fall back by shape.
  const unmeasured = ['tape-echo', 'reverse-space', 'gated-room'].map((id) => getEffectSpec(id));
  for (const spec of unmeasured) {
    const size = footprintOf(spec.id);
    assert.ok(Object.values(FOOTPRINTS).some((entry) => entry.w === size.w && entry.h === size.h), spec.id);
  }
});

test('grid snapping, overlap with a gap and the nearest free spot', () => {
  assert.equal(snap(12.4), 10);
  assert.equal(snap(12.6), 15);
  const a = { x: 50, y: 20, w: 73, h: 130 };
  assert.ok(rectsOverlap(a, { x: 125, y: 20, w: 73, h: 130 }), 'closer than the 4 mm gap');
  assert.ok(!rectsOverlap(a, { x: 130, y: 20, w: 73, h: 130 }));
  const spot = nearestFreeSpot({ x: 60, y: 20 }, { w: 73, h: 130 }, [a])!;
  assert.ok(spot && !rectsOverlap({ ...spot, w: 73, h: 130 }, a));
  assert.equal(spot.x % 5, 0);
});

test('alignment guides lock edges and centres only within tolerance', () => {
  const neighbour = { x: 100, y: 40, w: 73, h: 130 };
  const near = alignToGuides({ x: 200, y: 40 + GUIDE_TOLERANCE_MM - 1, w: 73, h: 130 }, [neighbour]);
  assert.equal(near.y, 40, 'tops line up');
  assert.ok(near.guides.some((guide) => guide.axis === 'y' && guide.at === 40));
  const far = alignToGuides({ x: 200, y: 40 + GUIDE_TOLERANCE_MM + 3, w: 73, h: 130 }, [neighbour]);
  assert.equal(far.y, 40 + GUIDE_TOLERANCE_MM + 3);
  assert.equal(far.guides.length, 0);
});

test('board size fits its pedals but never shrinks below a real board', () => {
  assert.deepEqual(boardSize([]), MIN_BOARD);
  const big = boardSize([{ x: 600, y: 300, w: 146, h: 178 }]);
  assert.ok(big.w >= 746 && big.h >= 478);
});

test('flow direction mirrors the view: rtl puts the guitar input on the right', () => {
  const board = { w: 610, h: 320 };
  const input = plateRect(INPUT_NODE, board);
  const output = plateRect(OUTPUT_NODE, board);
  assert.ok(input.x < output.x, 'in signal space the input is upstream (left)');
  const inputView = viewRect(input, board, 'rtl');
  const outputView = viewRect(output, board, 'rtl');
  assert.ok(inputView.x > outputView.x, 'rtl draws the input at the right edge');
  // A pedal's input jack is on its upstream side: left in ltr, right in rtl.
  const pedal = { x: 100, y: 40, w: 73, h: 130 };
  const jackIn = jackPoint(pedal, 'p', 'in');
  const jackOut = jackPoint(pedal, 'p', 'out');
  assert.ok(jackIn.x < jackOut.x);
  assert.ok(viewX(jackIn.x, board, 'rtl') > viewX(jackOut.x, board, 'rtl'));
  // View and signal space round-trip.
  const view = viewRect(pedal, board, 'rtl');
  assert.deepEqual(signalPoint({ x: view.x, y: view.y }, pedal, board, 'rtl'), { x: 100, y: 40 });
  // Cable handles leave the source jack downstream: +x in ltr, -x in rtl.
  const ltr = cablePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 'ltr');
  const rtl = cablePath({ x: 100, y: 0 }, { x: 0, y: 0 }, 'rtl');
  assert.ok(Number(ltr.split(' ')[4]) > 0);
  assert.ok(Number(rtl.split(' ')[4]) < 100);
});

test('auto layout: serial rows wrap without overlaps; parallel lanes sit between splitter and mixer', () => {
  const ids = ['ds1-dist', 'blue-drive', 'wall-fuzz', 'analog-chorus', 'dm2-delay', 'cloud-hall', 'analog-delay', 'klon-centaur'];
  const chain = ids.map((specId, index) => ({ instanceId: `p${index}`, specId, lane: (index % 2 ? 'B' : 'A') as 'A' | 'B' }));
  const serial = autoLayout(chain, 'serial', []);
  const rects = chain.map((item) => ({ ...serial[item.instanceId], ...footprintOf(item.specId) }));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) assert.ok(!rectsOverlap(rects[i], rects[j], 0), `${i} vs ${j}`);
  }
  assert.ok(new Set(rects.map((rect) => rect.y)).size > 1, 'a long chain wraps onto another row');
  const parallel = autoLayout(chain, 'parallel', []);
  const laneA = chain.filter((item) => item.lane === 'A').map((item) => parallel[item.instanceId]);
  const laneB = chain.filter((item) => item.lane === 'B').map((item) => parallel[item.instanceId]);
  assert.ok(Math.max(...laneA.map((point) => point.y)) < Math.min(...laneB.map((point) => point.y)), 'lane A above lane B');
  assert.ok(parallel[SPLITTER_NODE].x < Math.min(...[...laneA, ...laneB].map((point) => point.x)));
  assert.ok(parallel[MIXER_NODE].x > Math.max(...[...laneA, ...laneB].map((point) => point.x)));
});

test('photo footswitch hit areas follow the annotated switch on each photo', async () => {
  const { skinSwitchBox } = await import('../studio/board-geometry.ts');
  // A round MXR-style switch at 53% / 72% with radius 11% of the width, on a 64×111 mm pedal.
  const round = skinSwitchBox({ shape: 'circle', x: 0.53, y: 0.72, r: 0.11 }, 64, 111);
  assert.ok(Math.abs(round.width - 14.08) < 1e-9 && round.width === round.height && round.round);
  assert.ok(Math.abs(round.left + round.width / 2 - 0.53 * 64) < 1e-9);
  assert.ok(Math.abs(round.top + round.height / 2 - 0.72 * 111) < 1e-9);
  // A Boss rubber pad: a rectangle across the lower third.
  const pad = skinSwitchBox({ shape: 'rect', x: 0.5, y: 0.785, w: 0.84, h: 0.33 }, 73, 130);
  assert.ok(!pad.round && Math.abs(pad.left - 0.08 * 73) < 1e-9 && Math.abs(pad.top + pad.height - 0.95 * 130) < 1e-9);
});
