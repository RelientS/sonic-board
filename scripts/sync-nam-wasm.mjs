import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDist = resolve(projectRoot, 'node_modules/@opendaw/nam-wasm/dist');
const publicDist = resolve(projectRoot, 'public/audio/nam');
const runtimeFiles = ['nam.js', 'nam.wasm', 'NamWasmModule.js', 'NamModel.js'];

await mkdir(publicDist, { recursive: true });
await Promise.all(runtimeFiles.map((fileName) => copyFile(
  resolve(packageDist, fileName),
  resolve(publicDist, fileName),
)));
