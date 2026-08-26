import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { transformPiEnvApiKeys } from '../build/pi-vinext-compat.ts';

test('Pi env loading uses statically analyzable Node imports in Vinext builds', () => {
  const source = readFileSync(
    new URL('../../node_modules/@earendil-works/pi-ai/dist/env-api-keys.js', import.meta.url),
    'utf8',
  );
  const result = transformPiEnvApiKeys(
    '/workspace/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js',
    source,
  );

  assert.ok(result);
  assert.doesNotMatch(result.code, /dynamicImport|NODE_(?:FS|OS|PATH)_SPECIFIER/);
  assert.match(result.code, /import\("node:fs"\)/);
  assert.match(result.code, /import\("node:os"\)/);
  assert.match(result.code, /import\("node:path"\)/);
});
