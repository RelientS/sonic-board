// Owner-only assets besides the amp captures: pedal photo skins
// (SONIC_DATA_DIR/skins/) and pedal NAM captures (SONIC_DATA_DIR/pedals/).
// Like the amps, their licenses allow personal use only, so they are never
// part of the public build and are served only to SONIC_OWNER_USERNAMES.
import { nodeFs, nodePath } from './node-builtins.ts';
import { isOwnerUsername } from './private-amps.ts';
import { getAccountService } from './service.ts';
import { readCookie, SESSION_COOKIE } from './session.ts';
import { resolveDataDir } from './store.ts';

export type PrivateSkinEntry = { specId: string; file: string; widthIn?: number; heightIn?: number };
export type PrivatePedalModelEntry = { id: string; file: string; slotId: string; name: string; setting: string; author?: string; url?: string; loudness?: number | null };

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 'owner' | 'user' (signed in, not owner) | 'anonymous'. */
export async function requestRole(request: Request) {
  const user = await getAccountService().authenticate(readCookie(request.headers.get('cookie'), SESSION_COOKIE));
  if (!user) return 'anonymous' as const;
  return isOwnerUsername(user.account.username) ? 'owner' as const : 'user' as const;
}

async function readManifest(dir: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await nodeFs().readFile(nodePath().join(dir, 'manifest.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function privateAssetDir(kind: 'skins' | 'pedals', dataDir = resolveDataDir()) {
  return nodePath().join(dataDir, kind);
}

export async function listPrivateSkins(dir = privateAssetDir('skins')): Promise<PrivateSkinEntry[]> {
  return (await readManifest(dir)).filter((entry): entry is PrivateSkinEntry => {
    const candidate = entry as PrivateSkinEntry;
    return typeof candidate?.specId === 'string' && ID.test(candidate.specId) &&
      typeof candidate.file === 'string' && /^[a-z0-9][a-z0-9._-]*\.webp$/i.test(candidate.file);
  });
}

export async function readPrivateSkin(specId: string, dir = privateAssetDir('skins')) {
  if (!ID.test(specId)) return null;
  const entry = (await listPrivateSkins(dir)).find((candidate) => candidate.specId === specId);
  // The manifest filter rejects path separators, so the file stays inside `dir`.
  return entry ? nodeFs().readFile(nodePath().join(dir, entry.file)) : null;
}

export async function listPrivatePedalModels(dir = privateAssetDir('pedals')): Promise<PrivatePedalModelEntry[]> {
  return (await readManifest(dir)).filter((entry): entry is PrivatePedalModelEntry => {
    const candidate = entry as PrivatePedalModelEntry;
    return typeof candidate?.id === 'string' && ID.test(candidate.id) &&
      typeof candidate.file === 'string' && /^[a-z0-9][a-z0-9._-]*\.nam$/i.test(candidate.file) &&
      typeof candidate.slotId === 'string' && typeof candidate.name === 'string' && typeof candidate.setting === 'string';
  });
}

export async function readPrivatePedalModel(id: string, dir = privateAssetDir('pedals')) {
  if (!ID.test(id)) return null;
  const entry = (await listPrivatePedalModels(dir)).find((candidate) => candidate.id === id);
  return entry ? nodeFs().readFile(nodePath().join(dir, entry.file), 'utf8') : null;
}
