import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const route = readFileSync(new URL('../api/tone-agent/route.ts', import.meta.url), 'utf8');

test('tone agent route keeps credentials server-side and calls the configured model', () => {
  assert.match(route, /process\.env\.TOKEN_SHARE_KEY/);
  assert.match(route, /https:\/\/token-share\.app\/v1\/responses/);
  assert.match(route, /gpt-5\.6-terra/);
  assert.match(route, /x-session-id/);
  assert.doesNotMatch(route, /sk-token-/);
});
