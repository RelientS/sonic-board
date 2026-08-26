import assert from 'node:assert/strict';
import test from 'node:test';

import { stopLiveGraph, type LiveAudioSession } from './audio-engine.ts';

test('stopping a live graph disconnects its final output so effect tails cannot leak', () => {
  let sourceStops = 0;
  let sourceDisconnects = 0;
  let outputDisconnects = 0;
  const session = {
    source: {
      stop: () => { sourceStops += 1; },
      disconnect: () => { sourceDisconnects += 1; },
    },
    output: {
      disconnect: () => { outputDisconnects += 1; },
    },
    scheduled: [],
  } as unknown as LiveAudioSession;

  stopLiveGraph(session);

  assert.equal(sourceStops, 1);
  assert.equal(sourceDisconnects, 1);
  assert.equal(outputDisconnects, 1);
  assert.equal(session.source, null);
  assert.equal(session.output, null);
});
