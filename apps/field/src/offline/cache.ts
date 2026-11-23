import { decryptJson, encryptJson } from './crypto.js';
import type { FieldDb } from './db.js';

/** Encrypted key/value cache for data the app shows offline (profile, home cards). */
export async function putCached(db: FieldDb, key: CryptoKey, name: string, value: unknown, now = Date.now()): Promise<void> {
  await db.cache.put({ key: name, data: await encryptJson(key, value), updatedAt: now });
}

export async function getCached<T>(db: FieldDb, key: CryptoKey, name: string): Promise<{ value: T; updatedAt: number } | undefined> {
  const row = await db.cache.get(name);
  if (!row) return undefined;
  try {
    return { value: await decryptJson<T>(key, row.data), updatedAt: row.updatedAt };
  } catch {
    return undefined;
  }
}
