import assert from 'node:assert/strict';
import test from 'node:test';

import { parseToneAgentSseChunk } from '../agent/tone-agent-stream.ts';

test('agent stream parser keeps partial SSE blocks and emits complete events', () => {
  const first = parseToneAgentSseChunk('', 'data: {"type":"thinking_delta","delta":"正在读取"}\r\n\r\ndata: {"type":"trace",');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'thinking_delta');
  assert.match(first.rest, /trace/);

  const second = parseToneAgentSseChunk(first.rest, '"step":{"id":"1","kind":"observe","status":"completed","title":"读取当前音色","detail":"5 块效果器","toolName":"inspect_board"}}\n\n');
  assert.equal(second.rest, '');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].type, 'trace');
});

test('agent stream parser accepts heartbeat comments without creating fake messages', () => {
  const result = parseToneAgentSseChunk('', ': heartbeat\n\ndata: {"type":"text_delta","delta":"可以。"}\n\n');
  assert.deepEqual(result.events, [{ type: 'text_delta', delta: '可以。' }]);
});

