// Amp captures that may only be used privately (their licenses forbid
// redistribution). They live outside the public build, in
// SONIC_DATA_DIR/amps/, and are served only to accounts listed in
// SONIC_OWNER_USERNAMES (comma separated).
import { nodeFs, nodePath } from './node-builtins.ts';
import { resolveDataDir } from './store.ts';

export type PrivateAmpEntry = {
  id: string;
  file: string;
  amp: string;
  setting: string;
  author?: string;
  url?: string;
  sampleRate?: number;
  /** Capture loudness from the model metadata (dB), used to level-match. */
  loudness?: number | null;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isOwnerUsername(username: string, env: string | undefined = process.env.SONIC_OWNER_USERNAMES) {
  const owners = (env ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  return owners.includes(username.toLowerCase());
}

export function privateAmpDir(dataDir = resolveDataDir()) {
  return nodePath().join(dataDir, 'amps');
}

export async function listPrivateAmps(dir = privateAmpDir()): Promise<PrivateAmpEntry[]> {
  let raw: string;
  try {
    raw = await nodeFs().readFile(nodePath().join(dir, 'manifest.json'), 'utf8');
  } catch {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is PrivateAmpEntry =>
    typeof entry?.id === 'string' && ID_PATTERN.test(entry.id) &&
    typeof entry.file === 'string' && /^[a-z0-9][a-z0-9._-]*\.nam$/i.test(entry.file) &&
    typeof entry.amp === 'string' && typeof entry.setting === 'string');
}

/** The model JSON for `id`, or null when it is not in the manifest. */
export async function readPrivateAmp(id: string, dir = privateAmpDir()) {
  if (!ID_PATTERN.test(id)) return null;
  const entry = (await listPrivateAmps(dir)).find((candidate) => candidate.id === id);
  if (!entry) return null;
  // The manifest filter rejects path separators, so the file stays inside `dir`.
  return nodeFs().readFile(nodePath().join(dir, entry.file), 'utf8');
}
