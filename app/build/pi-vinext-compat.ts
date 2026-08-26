const PI_ENV_API_KEYS_SUFFIX = '/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js';

type TransformResult = { code: string; map: null };

export function transformPiEnvApiKeys(id: string, source: string): TransformResult | null {
  const normalizedId = id.split('?')[0].replaceAll('\\', '/');
  if (!normalizedId.endsWith(PI_ENV_API_KEYS_SUFFIX)) return null;

  const dynamicLoader = [
    'const dynamicImport = (specifier) => import(specifier);',
    'const NODE_FS_SPECIFIER = "node:" + "fs";',
    'const NODE_OS_SPECIFIER = "node:" + "os";',
    'const NODE_PATH_SPECIFIER = "node:" + "path";',
  ].join('\n');
  if (!source.includes(dynamicLoader)) {
    throw new Error('Unsupported @earendil-works/pi-ai env loader; update the Vinext compatibility transform.');
  }

  const code = source
    .replace(dynamicLoader, '')
    .replaceAll('dynamicImport(NODE_FS_SPECIFIER)', 'import("node:fs")')
    .replaceAll('dynamicImport(NODE_OS_SPECIFIER)', 'import("node:os")')
    .replaceAll('dynamicImport(NODE_PATH_SPECIFIER)', 'import("node:path")');

  return { code, map: null };
}

export function piVinextCompat() {
  return {
    name: 'sonic-board:pi-vinext-compat',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      return transformPiEnvApiKeys(id, source);
    },
  };
}
