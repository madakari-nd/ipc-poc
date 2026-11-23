import { newIdempotencyKey, setCsrfToken } from '../lib/api.js';
import { deriveKey } from './crypto.js';
import type { FieldDb } from './db.js';
import type { Transport } from './outbox.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Offline data is deleted after more than 7 x 24 h without reaching the server (device time). */
export const OFFLINE_LIMIT_MS = 7 * DAY_MS;
/** The user is warned from day 5. */
export const WARN_AFTER_MS = 5 * DAY_MS;

export interface OfflineSession {
  userId: string;
  key: CryptoKey;
  signedInAt: number;
  /** Last successful contact with the server; the 7-day guard counts from here. */
  lastOnlineAt: number;
}

export interface GuardState {
  status: 'none' | 'ok' | 'warn' | 'expired';
  daysLeft: number;
}

export function evaluateOfflineGuard(lastOnlineAt: number, now: number): GuardState {
  const elapsed = now - lastOnlineAt;
  const daysLeft = Math.max(0, Math.ceil((OFFLINE_LIMIT_MS - elapsed) / DAY_MS));
  if (elapsed > OFFLINE_LIMIT_MS) return { status: 'expired', daysLeft: 0 };
  if (elapsed >= WARN_AFTER_MS) return { status: 'warn', daysLeft };
  return { status: 'ok', daysLeft };
}

/**
 * Called at sign-in: derives the AES-GCM key from the password and the server-provided salt and
 * keeps it (non-extractable) in IndexedDB so the app can reopen offline. A different user's data is
 * removed first.
 */
export async function establishOfflineSession(
  db: FieldDb,
  args: { userId: string; password: string; saltB64: string; now?: number; iterations?: number },
): Promise<CryptoKey> {
  const now = args.now ?? Date.now();
  const existing = await loadOfflineSession(db);
  if (existing && existing.userId !== args.userId) {
    await db.transaction('rw', [db.outbox, db.files, db.cache, db.meta], async () => {
      await Promise.all([db.outbox.clear(), db.files.clear(), db.cache.clear(), db.meta.clear()]);
    });
  }
  const key = await deriveKey(args.password, args.saltB64, args.iterations);
  const session: OfflineSession = { userId: args.userId, key, signedInAt: now, lastOnlineAt: now };
  await db.meta.put({ key: 'session', value: session });
  return key;
}

export async function loadOfflineSession(db: FieldDb): Promise<OfflineSession | undefined> {
  const row = await db.meta.get('session');
  return row?.value as OfflineSession | undefined;
}

export async function markOnline(db: FieldDb, now: number = Date.now()): Promise<void> {
  const s = await loadOfflineSession(db);
  if (s) await db.meta.put({ key: 'session', value: { ...s, lastOnlineAt: now } });
}

/** Deletes the whole Dexie database, including the derived key. */
export async function wipeOfflineData(db: FieldDb): Promise<void> {
  await db.delete();
}

/** Applies the 7-day rule; wipes when expired. */
export async function enforceOfflineGuard(db: FieldDb, now: number = Date.now()): Promise<GuardState> {
  const s = await loadOfflineSession(db);
  if (!s) return { status: 'none', daysLeft: 0 };
  const state = evaluateOfflineGuard(s.lastOnlineAt, now);
  if (state.status === 'expired') await wipeOfflineData(db);
  return state;
}

/** Ends the server session when reachable and always wipes local data and the key. */
export async function signOutAndWipe(db: FieldDb, transport: Transport): Promise<void> {
  try {
    await transport.request('/ipc/v1/auth/logout', { method: 'POST', idempotencyKey: newIdempotencyKey() });
  } catch {
    // Offline, or the server session is already gone: local data is wiped regardless.
  } finally {
    setCsrfToken(undefined);
    await wipeOfflineData(db);
  }
}
