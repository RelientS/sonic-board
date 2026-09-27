// Tiny JSON-file persistence for account state. The narrow interface
// (`read` / `transact`) is all the rest of the app depends on, so it can be
// replaced by SQLite later without touching the domain logic.
import { emptyAccountState, pruneAccountState, type AccountState } from './accounts.ts';
import { nodeFs, nodePath } from './node-builtins.ts';

export interface AccountStore {
  /** Runs `fn` against a snapshot; mutations are discarded. */
  read<T>(fn: (state: AccountState) => T): Promise<T>;
  /** Runs `fn` exclusively; the state is persisted atomically if it returns without throwing. */
  transact<T>(fn: (state: AccountState, now: number) => T): Promise<T>;
}

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 15_000;

export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}

function isAccountState(value: unknown): value is AccountState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<AccountState>;
  return state.version === 1 && typeof state.users === 'object' && typeof state.sessions === 'object'
    && Array.isArray(state.ledger) && Array.isArray(state.registrations);
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveDataDir() {
  return nodePath().resolve(process.env.SONIC_DATA_DIR || './.data');
}

export class JsonAccountStore implements AccountStore {
  readonly file: string;
  private readonly lockFile: string;
  private readonly exclusive = createMutex();
  private readonly clock: () => number;

  constructor(dataDir: string = resolveDataDir(), clock: () => number = Date.now) {
    this.file = nodePath().join(dataDir, 'accounts.json');
    this.lockFile = `${this.file}.lock`;
    this.clock = clock;
  }

  private async load(): Promise<AccountState> {
    let text: string;
    try {
      text = await nodeFs().readFile(this.file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyAccountState();
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isAccountState(parsed)) throw new Error(`Unrecognized account store format: ${this.file}`);
    return parsed;
  }

  private async save(state: AccountState) {
    const fs = nodeFs();
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  // Cross-process lock so the admin CLI and the server never interleave
  // read-modify-write cycles. Inside one process the mutex already serializes.
  private async withFileLock<T>(task: () => Promise<T>) {
    const fs = nodeFs();
    await fs.mkdir(nodePath().dirname(this.file), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try {
        await fs.writeFile(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const stat = await fs.stat(this.lockFile).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(this.lockFile, { force: true });
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('account store is locked');
        await wait(LOCK_RETRY_MS);
      }
    }
    try {
      return await task();
    } finally {
      await fs.rm(this.lockFile, { force: true });
    }
  }

  read<T>(fn: (state: AccountState) => T) {
    return this.exclusive(async () => fn(await this.load()));
  }

  transact<T>(fn: (state: AccountState, now: number) => T) {
    return this.exclusive(() => this.withFileLock(async () => {
      const state = await this.load();
      const now = this.clock();
      const result = fn(state, now);
      pruneAccountState(state, now);
      await this.save(state);
      return result;
    }));
  }
}

/** In-memory store with the same semantics, for tests. */
export class MemoryAccountStore implements AccountStore {
  state: AccountState = emptyAccountState();
  private readonly exclusive = createMutex();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  read<T>(fn: (state: AccountState) => T) {
    return this.exclusive(async () => fn(structuredClone(this.state)));
  }

  transact<T>(fn: (state: AccountState, now: number) => T) {
    return this.exclusive(async () => {
      const draft = structuredClone(this.state);
      const now = this.clock();
      const result = fn(draft, now);
      pruneAccountState(draft, now);
      this.state = draft;
      return result;
    });
  }
}
