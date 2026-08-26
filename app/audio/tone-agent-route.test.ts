import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const route = readFileSync(new URL('../api/tone-agent/route.ts', import.meta.url), 'utf8');

test('tone agent route keeps credentials server-side and streams the Pi agent', () => {
  assert.match(route, /process\.env\.TOKEN_SHARE_KEY/);
  assert.match(route, /runToneAgent/);
  assert.match(route, /text\/event-stream/);
  assert.match(route, /heartbeat/);
  assert.match(route, /request\.signal/);
  assert.doesNotMatch(route, /sk-token-/);
});
