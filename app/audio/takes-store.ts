/**
 * Recorded or uploaded guitar takes, kept only in this browser (IndexedDB).
 * Boards and presets refer to a take by id; the audio never leaves the
 * device, never goes into presets or undo history.
 */
export type TakeSource = 'upload' | 'recording';

export type TakeMeta = {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  durationSeconds: number;
  source: TakeSource;
};

export type TakeRecord = TakeMeta & {
  /** Mono DI signal at its original level. */
  channel: Float32Array;
};

export const MAX_UPLOAD_SECONDS = 120;
export const MAX_RECORDING_SECONDS = 60;
const TAKE_NAME_LIMIT = 40;

export type TakeStorage = {
  list(): Promise<TakeMeta[]>;
  get(id: string): Promise<TakeRecord | null>;
  put(record: TakeRecord): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
};

export function cleanTakeName(name: string, fallback = '未命名录音') {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, TAKE_NAME_LIMIT);
  return trimmed || fallback;
}

export function makeTakeId(now = Date.now(), random = Math.random) {
  return `take-${now.toString(36)}-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

export function metaOf(record: TakeRecord): TakeMeta {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    sampleRate: record.sampleRate,
    durationSeconds: record.durationSeconds,
    source: record.source,
  };
}

function sortNewestFirst(takes: TakeMeta[]) {
  return takes.sort((left, right) => right.createdAt - left.createdAt);
}

/** For tests and browsers without IndexedDB (takes last until reload). */
export function createMemoryTakeStorage(): TakeStorage {
  const records = new Map<string, TakeRecord>();
  return {
    list: async () => sortNewestFirst([...records.values()].map(metaOf)),
    get: async (id) => records.get(id) ?? null,
    put: async (record) => { records.set(record.id, { ...record, channel: record.channel.slice() }); },
    rename: async (id, name) => {
      const record = records.get(id);
      if (record) records.set(id, { ...record, name: cleanTakeName(name, record.name) });
    },
    remove: async (id) => { records.delete(id); },
  };
}

const DATABASE_NAME = 'sonic-board-takes';
const META_STORE = 'takes';
const AUDIO_STORE = 'audio';

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Metadata and audio live apart so listing takes never loads audio.
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地录音库'));
  });
}

export function createIndexedDbTakeStorage(factory: IDBFactory): TakeStorage {
  const database = openDatabase(factory);
  return {
    list: async () => {
      const store = (await database).transaction(META_STORE, 'readonly').objectStore(META_STORE);
      return sortNewestFirst(await requestResult(store.getAll()) as TakeMeta[]);
    },
    get: async (id) => {
      const transaction = (await database).transaction([META_STORE, AUDIO_STORE], 'readonly');
      const [meta, channel] = await Promise.all([
        requestResult(transaction.objectStore(META_STORE).get(id)) as Promise<TakeMeta | undefined>,
        requestResult(transaction.objectStore(AUDIO_STORE).get(id)) as Promise<Float32Array | undefined>,
      ]);
      return meta && channel ? { ...meta, channel } : null;
    },
    put: async (record) => {
      const transaction = (await database).transaction([META_STORE, AUDIO_STORE], 'readwrite');
      transaction.objectStore(META_STORE).put(metaOf(record));
      transaction.objectStore(AUDIO_STORE).put(record.channel, record.id);
      await transactionDone(transaction);
    },
    rename: async (id, name) => {
      const transaction = (await database).transaction(META_STORE, 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const meta = await requestResult(store.get(id)) as TakeMeta | undefined;
      if (meta) store.put({ ...meta, name: cleanTakeName(name, meta.name) });
      await transactionDone(transaction);
    },
    remove: async (id) => {
      const transaction = (await database).transaction([META_STORE, AUDIO_STORE], 'readwrite');
      transaction.objectStore(META_STORE).delete(id);
      transaction.objectStore(AUDIO_STORE).delete(id);
      await transactionDone(transaction);
    },
  };
}

export function createBrowserTakeStorage(): TakeStorage {
  if (typeof indexedDB === 'undefined') return createMemoryTakeStorage();
  return createIndexedDbTakeStorage(indexedDB);
}

/** Averages channels to mono and cuts to `maxSeconds`, keeping the level. */
export function mixToMono(channels: Float32Array[], sampleRate: number, maxSeconds = MAX_UPLOAD_SECONDS) {
  const length = Math.min(channels[0]?.length ?? 0, Math.floor(maxSeconds * sampleRate));
  const mono = new Float32Array(length);
  if (channels.length === 0) return mono;
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] * scale;
  }
  return mono;
}

/**
 * Decodes an audio file (WAV/MP3/FLAC/M4A/OGG — whatever the browser can
 * decode) into a mono take, capped at MAX_UPLOAD_SECONDS.
 */
export async function decodeTakeFile(file: File, now = Date.now()): Promise<TakeRecord> {
  const bytes = await file.arrayBuffer();
  // Decoding in an offline context keeps the file's own sample rate.
  const OfflineContext = window.OfflineAudioContext ||
    (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const context = new OfflineContext(1, 1, 48_000);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(bytes);
  } catch {
    throw new Error('无法读取这个文件：请用 WAV、MP3、FLAC、M4A 或 OGG 格式。');
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const channel = mixToMono(channels, decoded.sampleRate);
  if (channel.length < decoded.sampleRate * 0.25) throw new Error('这段音频太短了，至少需要 0.25 秒。');
  return {
    id: makeTakeId(now),
    name: cleanTakeName(file.name.replace(/\.[^.]+$/, ''), '上传的录音'),
    createdAt: now,
    sampleRate: decoded.sampleRate,
    durationSeconds: channel.length / decoded.sampleRate,
    source: 'upload',
    channel,
  };
}

export function makeRecordedTake(channel: Float32Array, sampleRate: number, name: string, now = Date.now()): TakeRecord {
  const capped = channel.length > MAX_RECORDING_SECONDS * sampleRate ? channel.slice(0, MAX_RECORDING_SECONDS * sampleRate) : channel;
  return {
    id: makeTakeId(now),
    name: cleanTakeName(name, '我的录音'),
    createdAt: now,
    sampleRate,
    durationSeconds: capped.length / sampleRate,
    source: 'recording',
    channel: capped,
  };
}
