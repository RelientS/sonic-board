const MAX_NAM_MODEL_BYTES = 16 * 1024 * 1024;
const SUPPORTED_A1_ARCHITECTURES = new Set(['Linear', 'ConvNet', 'LSTM', 'WaveNet']);
const DATABASE_NAME = 'sonic-board-private-nam';
const MODEL_STORE_NAME = 'models';

export type ParsedNamModel = {
  fileName: string;
  name: string;
  architecture: string;
  sampleRate: number;
  modelJson: string;
};

export type NamModelRecord = ParsedNamModel & {
  slotId: string;
  importedAt: number;
};

type NamDocument = {
  version?: unknown;
  architecture?: unknown;
  config?: unknown;
  metadata?: unknown;
  sample_rate?: unknown;
  weights?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNamModel(modelJson: string, fileName: string): ParsedNamModel {
  if (!/\.nam$/i.test(fileName)) throw new Error('请选择 .nam 模型文件');
  if (!modelJson.trim()) throw new Error('NAM 模型文件为空');
  if (new TextEncoder().encode(modelJson).byteLength > MAX_NAM_MODEL_BYTES) {
    throw new Error('NAM 模型超过 16 MB 的本地导入上限');
  }

  let document: NamDocument;
  try {
    document = JSON.parse(modelJson) as NamDocument;
  } catch {
    throw new Error('NAM 模型不是有效的 JSON 文档');
  }

  if (!isRecord(document)) throw new Error('NAM 模型文档无效');
  if (typeof document.version !== 'string' || !document.version.startsWith('0.5.')) {
    throw new Error('当前浏览器运行时只支持 A1 Legacy NAM（0.5.x）');
  }
  if (typeof document.architecture !== 'string' || !SUPPORTED_A1_ARCHITECTURES.has(document.architecture)) {
    throw new Error(`不支持的 NAM architecture：${String(document.architecture ?? '未知')}`);
  }
  if (!isRecord(document.config)) throw new Error('NAM 模型缺少 config');
  const layers = Array.isArray(document.config.layers) ? document.config.layers : [];
  if (layers.some((layer) => isRecord(layer) && ('gating_mode' in layer || 'bottleneck' in layer))) {
    throw new Error('当前浏览器运行时不支持 A2 NAM，请改下 A1 Legacy capture');
  }
  if (!Array.isArray(document.weights) || document.weights.length === 0 || !document.weights.every(Number.isFinite)) {
    throw new Error('NAM 模型缺少有效 weights');
  }

  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const rawSampleRate = document.sample_rate ?? metadata.sample_rate;
  const sampleRate = typeof rawSampleRate === 'number' && Number.isFinite(rawSampleRate) && rawSampleRate >= 8_000 && rawSampleRate <= 384_000
    ? rawSampleRate
    : 48_000;
  const fallbackName = fileName.replace(/\.nam$/i, '').trim() || 'Local NAM';
  const name = [metadata.name, metadata.gear_model].find((value) => typeof value === 'string' && value.trim()) as string | undefined;

  return {
    fileName,
    name: name?.trim() ?? fallbackName,
    architecture: document.architecture,
    sampleRate,
    modelJson,
  };
}

export function createNamModelRecord(
  slotId: string,
  parsed: ParsedNamModel,
  importedAt = Date.now(),
): NamModelRecord {
  if (!slotId.trim()) throw new Error('NAM 模型槽位不能为空');
  return { ...parsed, slotId, importedAt };
}

export type NamModelStorage = {
  get(slotId: string): Promise<NamModelRecord | null>;
  list(): Promise<NamModelRecord[]>;
  put(record: NamModelRecord): Promise<void>;
  remove(slotId: string): Promise<void>;
};

export class NamModelRepository {
  private readonly storage: NamModelStorage;

  constructor(storage: NamModelStorage) {
    this.storage = storage;
  }

  get(slotId: string) { return this.storage.get(slotId); }
  list() { return this.storage.list(); }
  save(record: NamModelRecord) { return this.storage.put(record); }
  remove(slotId: string) { return this.storage.remove(slotId); }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MODEL_STORE_NAME)) {
        request.result.createObjectStore(MODEL_STORE_NAME, { keyPath: 'slotId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地 NAM 模型库'));
  });
}

export function createIndexedDbNamModelStorage(factory: IDBFactory): NamModelStorage {
  const database = openDatabase(factory);
  const store = async (mode: IDBTransactionMode) => (await database).transaction(MODEL_STORE_NAME, mode).objectStore(MODEL_STORE_NAME);
  return {
    get: async (slotId) => (await requestResult((await store('readonly')).get(slotId)) as NamModelRecord | undefined) ?? null,
    list: async () => (await requestResult((await store('readonly')).getAll()) as NamModelRecord[])
      .sort((left, right) => right.importedAt - left.importedAt),
    put: async (record) => { await requestResult((await store('readwrite')).put(record)); },
    remove: async (slotId) => { await requestResult((await store('readwrite')).delete(slotId)); },
  };
}

export function createBrowserNamModelRepository() {
  if (typeof indexedDB === 'undefined') throw new Error('当前浏览器不支持本地 NAM 模型存储');
  return new NamModelRepository(createIndexedDbNamModelStorage(indexedDB));
}
