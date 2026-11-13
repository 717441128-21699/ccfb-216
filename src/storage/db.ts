/**
 * IndexedDB 封装：工程 JSON 与音频 blob 分开存。
 *  - kv:     排练元数据（key = rehearsal id）
 *  - blobs:  解码前的原始文件字节（key = material.blobKey）
 */

const DB_NAME = 'choir-align-mix';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_BLOB = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      }),
  );
}

export async function kvPut<T>(key: string, value: T): Promise<void> {
  await tx(STORE_KV, 'readwrite', (s) => s.put(value, key));
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>(STORE_KV, 'readonly', (s) => s.get(key));
}

export async function kvDelete(key: string): Promise<void> {
  await tx(STORE_KV, 'readwrite', (s) => s.delete(key));
}

export async function kvAllKeys(): Promise<string[]> {
  return tx<IDBValidKey[]>(STORE_KV, 'readonly', (s) => s.getAllKeys()).then((ks) =>
    ks.map(String),
  );
}

export async function blobPut(key: string, data: Blob): Promise<void> {
  await tx(STORE_BLOB, 'readwrite', (s) => s.put(data, key));
}

export async function blobGet(key: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(STORE_BLOB, 'readonly', (s) => s.get(key));
}

export async function blobDelete(key: string): Promise<void> {
  await tx(STORE_BLOB, 'readwrite', (s) => s.delete(key));
}
