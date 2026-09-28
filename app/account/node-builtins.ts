// Node built-ins are resolved at runtime through `process.getBuiltinModule`
// instead of static `import 'node:*'` so the Vite/Cloudflare build never tries
// to bundle or polyfill them. The production server (`vinext start`) and the
// admin CLI both run on Node >= 22.13, where this API is always available.
type NodeCrypto = typeof import('node:crypto');
type NodeFs = typeof import('node:fs/promises');
type NodePath = typeof import('node:path');

function builtin<T>(id: string): T {
  const loader = (globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined)?.getBuiltinModule;
  if (typeof loader !== 'function') throw new Error(`Node built-in ${id} is unavailable in this runtime.`);
  return loader(id) as T;
}

export const nodeCrypto = () => builtin<NodeCrypto>('node:crypto');
export const nodeFs = () => builtin<NodeFs>('node:fs/promises');
export const nodePath = () => builtin<NodePath>('node:path');

/** Base64url without padding; avoids Buffer#toString overloads that clash with the Workers type definitions. */
export function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
