// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, deriveKey, encryptJson, sha256Hex } from '../src/offline/crypto.js';
import { openDb, type FieldDb } from '../src/offline/db.js';
import { Outbox, type Transport, type TransportRequest } from '../src/offline/outbox.js';
import {
  OFFLINE_LIMIT_MS,
  WARN_AFTER_MS,
  enforceOfflineGuard,
  establishOfflineSession,
  evaluateOfflineGuard,
  loadOfflineSession,
  signOutAndWipe,
} from '../src/offline/session.js';
import { MAX_ATTEMPTS, SYNC_TAG, backoffDelay, registerBackgroundSync } from '../src/offline/sync.js';
import { ApiError, NetworkError } from '../src/lib/api.js';

const SALT = 'c2FsdHNhbHRzYWx0c2FsdA=='; // base64, server-provided in production
const DEVICE = '0f6e7a8e-6b1d-4b7a-9d1e-2c3f4a5b6c7d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Call extends TransportRequest {
  path: string;
}

/** Scriptable fake Edge: handlers by "METHOD path-prefix"; records every call in order. */
function fakeTransport() {
  const calls: Call[] = [];
  const uploads: { url: string; bytes: number }[] = [];
  const handlers: Array<{ match: (c: Call) => boolean; fn: (c: Call) => unknown }> = [];
  let evidenceSeq = 0;
  const on = (method: string, prefix: string, fn: (c: Call) => unknown) =>
    handlers.unshift({ match: (c) => c.method === method && c.path.startsWith(prefix), fn });
  // defaults (later registrations win)
  on('POST', '/ipc/v1/evidence/', (c) => ({ id: c.path.split('/')[4], state: 'confirmed' }));
  on('POST', '/ipc/v1/evidence/intents', () => {
    evidenceSeq += 1;
    return { evidence: { id: `ev${evidenceSeq}`, state: 'intent' }, upload: { url: `https://minio/ev${evidenceSeq}`, method: 'PUT', headers: {}, expiresAt: '' } };
  });
  on('POST', '/ipc/v1/tasks/', () => ({ ok: true }));
  on('PUT', '/ipc/v1/devices/', (c) => ({ ...(c.body as object), deviceId: DEVICE }));
  const transport: Transport = {
    async request<T>(path: string, init: TransportRequest): Promise<T> {
      const call = { path, ...init };
      calls.push(call);
      const h = handlers.find((x) => x.match(call));
      if (!h) throw new ApiError(404, { code: 'NOT_FOUND', title: 'nf', status: 404 });
      return h.fn(call) as T;
    },
    async upload(url, _method, _headers, bytes) {
      uploads.push({ url, bytes: bytes.byteLength });
    },
  };
  return { transport, calls, uploads, on };
}

let db: FieldDb;
let key: CryptoKey;
let now: number;
const clock = () => now;

beforeEach(async () => {
  db = openDb(`test-${Math.random()}`);
  now = Date.UTC(2026, 10, 1, 8, 0, 0);
  key = await establishOfflineSession(db, { userId: 'u1', password: 'pw', saltB64: SALT, now, iterations: 1000 });
});
afterEach(async () => {
  db.close();
});

function makeOutbox(transport: Transport) {
  return new Outbox({ db, key, transport, deviceId: DEVICE, now: clock, random: () => 0.5 });
}

const evidenceMeta = {
  sha256: 'a'.repeat(64),
  sizeBytes: 3,
  mime: 'image/jpeg' as const,
  capturedAt: '2026-11-01T08:00:00.000Z',
  gps: null,
  gpsUnavailable: true,
  wardId: 'w4',
  link: { type: 'task' as const, id: 't1' },
};

describe('crypto (AES-GCM, PBKDF2 key)', () => {
  it('round-trips JSON and produces ciphertext that does not contain the plaintext', async () => {
    const k = await deriveKey('secret', SALT, 1000);
    const sealed = await encryptJson(k, { note: 'hand hygiene' });
    expect(new TextDecoder().decode(sealed.ct)).not.toContain('hand hygiene');
    expect(await decryptJson(k, sealed)).toEqual({ note: 'hand hygiene' });
  });
  it('cannot decrypt with a key from another password', async () => {
    const sealed = await encryptJson(await deriveKey('a', SALT, 1000), { x: 1 });
    await expect(decryptJson(await deriveKey('b', SALT, 1000), sealed)).rejects.toThrow();
  });
  it('derives a non-extractable key', async () => {
    const k = await deriveKey('a', SALT, 1000);
    expect(k.extractable).toBe(false);
  });
  it('hashes with SHA-256 hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('outbox ordering and dependencies', () => {
  it('stores payloads encrypted at rest', async () => {
    const ob = makeOutbox(fakeTransport().transport);
    await ob.addRecord({ label: 'Secret label', method: 'POST', path: '/ipc/v1/tasks/t1/start', body: { note: 'private' } });
    const raw = JSON.stringify(await db.outbox.toArray(), (_k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? '[bytes]' : v));
    expect(raw).not.toContain('Secret label');
    expect(raw).not.toContain('private');
  });

  it('sends evidence files first, then records, then decisions, regardless of insertion order', async () => {
    const f = fakeTransport();
    const ob = makeOutbox(f.transport);
    await ob.addDecision({ label: 'decision', method: 'POST', path: '/ipc/v1/tasks/t9/acceptance', body: {} });
    await ob.addRecord({ label: 'record', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.addEvidence({ label: 'photo', bytes: new Uint8Array([1, 2, 3]), meta: evidenceMeta });
    const res = await ob.flush();
    expect(res.sent).toBe(3);
    expect(f.calls.map((c) => c.path)).toEqual([
      '/ipc/v1/evidence/intents',
      '/ipc/v1/evidence/ev1/confirmation',
      '/ipc/v1/tasks/t1/start',
      '/ipc/v1/tasks/t9/acceptance',
    ]);
    expect(f.uploads).toEqual([{ url: 'https://minio/ev1', bytes: 3 }]);
    expect((await ob.list()).every((i) => i.status === 'sent')).toBe(true);
  });

  it('gives every item its own UUID Idempotency-Key and reuses it on retry', async () => {
    const f = fakeTransport();
    let fail = true;
    f.on('POST', '/ipc/v1/tasks/t1', () => {
      if (fail) throw new NetworkError('offline');
      return {};
    });
    const ob = makeOutbox(f.transport);
    await ob.addRecord({ label: 'a', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.addRecord({ label: 'b', method: 'POST', path: '/ipc/v1/tasks/t2/start' });
    await ob.flush();
    fail = false;
    now += 60 * 60 * 1000;
    await ob.flush();
    const t1 = f.calls.filter((c) => c.path === '/ipc/v1/tasks/t1/start');
    const t2 = f.calls.filter((c) => c.path === '/ipc/v1/tasks/t2/start');
    expect(t1).toHaveLength(2);
    expect(t1[0]?.idempotencyKey).toMatch(UUID);
    expect(t1[0]?.idempotencyKey).toBe(t1[1]?.idempotencyKey);
    expect(t2[0]?.idempotencyKey).not.toBe(t1[0]?.idempotencyKey);
  });

  it('substitutes the server evidence id into dependent records and sends them only after confirmation', async () => {
    const f = fakeTransport();
    const ob = makeOutbox(f.transport);
    const ev = await ob.addEvidence({ label: 'photo', bytes: new Uint8Array([9]), meta: evidenceMeta });
    await ob.addRecord({
      label: 'submit',
      method: 'POST',
      path: '/ipc/v1/tasks/t1/evidence-submission',
      body: { evidenceIds: [{ $evidence: ev }], declaration: true },
      dependsOn: [ev],
    });
    await ob.flush();
    const submit = f.calls.find((c) => c.path.endsWith('evidence-submission'));
    expect(submit?.body).toEqual({ evidenceIds: ['ev1'], declaration: true });
    const confirmIdx = f.calls.findIndex((c) => c.path.endsWith('/confirmation'));
    expect(confirmIdx).toBeLessThan(f.calls.indexOf(submit as Call));
  });

  it('a failure blocks only the items that depend on it', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/evidence/intents', () => {
      throw new ApiError(503, { code: 'STORAGE_UNAVAILABLE', title: 'down', status: 503 });
    });
    const ob = makeOutbox(f.transport);
    const ev = await ob.addEvidence({ label: 'photo', bytes: new Uint8Array([1]), meta: evidenceMeta });
    const dependent = await ob.addRecord({ label: 'dep', method: 'POST', path: '/ipc/v1/tasks/t1/evidence-submission', body: {}, dependsOn: [ev] });
    const decision = await ob.addDecision({ label: 'dep2', method: 'POST', path: '/ipc/v1/tasks/t1/acceptance', dependsOn: [dependent] });
    const independent = await ob.addRecord({ label: 'free', method: 'POST', path: '/ipc/v1/tasks/t2/start' });
    await ob.flush();
    const items = Object.fromEntries((await ob.list()).map((i) => [i.id, i]));
    expect(items[independent]?.status).toBe('sent');
    expect(items[ev]?.status).toBe('pending');
    expect(items[ev]?.attempts).toBe(1);
    expect(items[dependent]?.status).toBe('pending');
    expect(items[dependent]?.blockedBy).toEqual([ev]);
    expect(items[decision]?.blockedBy).toEqual([dependent]);
    expect(f.calls.some((c) => c.path.endsWith('evidence-submission'))).toBe(false);
  });
});

describe('per-item status and errors', () => {
  it('403 SCOPE_DENIED marks the item "needs attention: access changed" and read-only', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/tasks/t1', () => {
      throw new ApiError(403, { code: 'SCOPE_DENIED', title: 'denied', status: 403 });
    });
    const ob = makeOutbox(f.transport);
    const id = await ob.addRecord({ label: 'x', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.flush();
    const [item] = await ob.list();
    expect(item).toMatchObject({ id, status: 'needs_attention', attention: 'access_changed', readOnly: true });
    await expect(ob.reapply(id, { body: {} })).rejects.toThrow(/read-only/);
    await expect(ob.retry(id)).rejects.toThrow(/read-only/);
    // never re-sent
    now += 24 * 3600 * 1000;
    await ob.flush();
    expect(f.calls.filter((c) => c.path === '/ipc/v1/tasks/t1/start')).toHaveLength(1);
  });

  it('409 VERSION_CONFLICT keeps the server version for the differences view and re-applies with a new key', async () => {
    const f = fakeTransport();
    let conflict = true;
    f.on('PUT', '/ipc/v1/plans/p1', () => {
      if (conflict) {
        throw new ApiError(409, { code: 'VERSION_CONFLICT', title: 'stale', status: 409, currentVersion: 4, current: { id: 'p1', v: 4, title: 'Server' } });
      }
      return {};
    });
    const ob = makeOutbox(f.transport);
    const id = await ob.addRecord({ label: 'edit', method: 'PUT', path: '/ipc/v1/plans/p1', body: { title: 'Mine' }, ifMatch: '3' });
    await ob.flush();
    const [item] = await ob.list();
    expect(item).toMatchObject({ status: 'needs_attention', attention: 'conflict', readOnly: false });
    const c = await ob.getConflict(id);
    expect(c?.mine).toEqual({ title: 'Mine' });
    expect(c?.currentVersion).toBe(4);
    expect(c?.current).toMatchObject({ title: 'Server' });

    conflict = false;
    await ob.reapply(id, { body: { title: 'Mine again' }, ifMatch: '4' });
    await ob.flush();
    const puts = f.calls.filter((c2) => c2.method === 'PUT' && c2.path === '/ipc/v1/plans/p1');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.ifMatch).toBe('4');
    expect(puts[1]?.idempotencyKey).not.toBe(puts[0]?.idempotencyKey);
    expect((await ob.list())[0]?.status).toBe('sent');
  });

  it('discarding a conflicted change keeps the server version and stops its dependents', async () => {
    const f = fakeTransport();
    f.on('PUT', '/ipc/v1/plans/p1', () => {
      throw new ApiError(409, { code: 'VERSION_CONFLICT', title: 'stale', status: 409, currentVersion: 2, current: {} });
    });
    const ob = makeOutbox(f.transport);
    const id = await ob.addRecord({ label: 'edit', method: 'PUT', path: '/ipc/v1/plans/p1', body: { a: 1 }, ifMatch: '1' });
    const dep = await ob.addDecision({ label: 'after', method: 'POST', path: '/ipc/v1/tasks/t1/acceptance', dependsOn: [id] });
    await ob.flush();
    await ob.discard(id);
    const items = await ob.list();
    expect(items.map((i) => i.id)).toEqual([dep]);
    expect(items[0]).toMatchObject({ status: 'needs_attention', attention: 'rejected', problemCode: 'DEPENDENCY_DISCARDED' });
  });

  it('other 4xx are "needs attention" without retry', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/tasks/t1', () => {
      throw new ApiError(422, { code: 'EVIDENCE_RULE_NOT_MET', title: 'no', status: 422 });
    });
    const ob = makeOutbox(f.transport);
    await ob.addRecord({ label: 'x', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.flush();
    expect((await ob.list())[0]).toMatchObject({ status: 'needs_attention', attention: 'rejected', problemCode: 'EVIDENCE_RULE_NOT_MET' });
  });

  it('retries with exponential backoff and jitter and gives up after the maximum attempts', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/tasks/t1', () => {
      throw new ApiError(503, { code: 'ELEVATE_UNAVAILABLE', title: 'down', status: 503 });
    });
    const ob = makeOutbox(f.transport);
    await ob.addRecord({ label: 'x', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.flush();
    const first = (await ob.list())[0];
    expect(first?.nextAttemptAt).toBe(now + backoffDelay(1, () => 0.5));
    // not retried before the backoff elapses
    await ob.flush();
    expect(f.calls).toHaveLength(1);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      now += 10 * 60 * 1000;
      await ob.flush();
    }
    expect(f.calls).toHaveLength(MAX_ATTEMPTS);
    expect((await ob.list())[0]).toMatchObject({ status: 'needs_attention', attention: 'retries_exhausted' });
    await ob.retry((await ob.list())[0]?.id as string);
    expect((await ob.list())[0]?.status).toBe('pending');
  });

  it('stops on 401 without counting an attempt (sign-in needed)', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/tasks/t1', () => {
      throw new ApiError(401, { code: 'SESSION_EXPIRED', title: 'x', status: 401 });
    });
    const ob = makeOutbox(f.transport);
    await ob.addRecord({ label: 'x', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    await ob.addRecord({ label: 'y', method: 'POST', path: '/ipc/v1/tasks/t2/start' });
    const res = await ob.flush();
    expect(res.authRequired).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect((await ob.list())[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('queue-status report', () => {
  it('reports counts and the oldest pending time to PUT /devices/{id}/queue-status', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/tasks/bad', () => {
      throw new ApiError(422, { code: 'VALIDATION_FAILED', title: 'x', status: 422 });
    });
    f.on('POST', '/ipc/v1/tasks/slow', () => {
      throw new NetworkError('offline');
    });
    const ob = makeOutbox(f.transport);
    const created = now;
    await ob.addRecord({ label: 'a', method: 'POST', path: '/ipc/v1/tasks/slow/start' });
    await ob.addRecord({ label: 'b', method: 'POST', path: '/ipc/v1/tasks/bad/start' });
    await ob.flush();
    await ob.reportQueueStatus();
    const put = f.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/ipc/v1/devices/${DEVICE}/queue-status`);
    expect(put?.idempotencyKey).toMatch(UUID);
    expect(put?.body).toMatchObject({ pendingCount: 1, failedCount: 1, oldestPendingAt: new Date(created).toISOString() });
  });
});

describe('background sync', () => {
  it('registers the sync tag when supported and reports false otherwise', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const nav = { serviceWorker: { ready: Promise.resolve({ sync: { register } }) } };
    expect(await registerBackgroundSync(nav as unknown as Navigator)).toBe(true);
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    expect(await registerBackgroundSync({} as Navigator)).toBe(false);
  });
  it('backoff grows exponentially, is capped, and is jittered', () => {
    expect(backoffDelay(2, () => 1)).toBe(2 * backoffDelay(1, () => 1));
    expect(backoffDelay(1, () => 0)).toBeLessThan(backoffDelay(1, () => 1));
    expect(backoffDelay(30, () => 1)).toBe(backoffDelay(31, () => 1));
  });
});

describe('7-day offline guard and wipe (Constitution VII)', () => {
  it('is ok before day 5, warns from day 5 and expires after 7 x 24 h of device time', () => {
    const t0 = 1_000_000;
    expect(evaluateOfflineGuard(t0, t0 + WARN_AFTER_MS - 1).status).toBe('ok');
    expect(evaluateOfflineGuard(t0, t0 + WARN_AFTER_MS).status).toBe('warn');
    expect(evaluateOfflineGuard(t0, t0 + OFFLINE_LIMIT_MS).status).toBe('warn');
    expect(evaluateOfflineGuard(t0, t0 + OFFLINE_LIMIT_MS + 1).status).toBe('expired');
  });

  it('keeps the derived key in the local store so the app reopens offline', async () => {
    const s = await loadOfflineSession(db);
    expect(s?.userId).toBe('u1');
    const sealed = await encryptJson(key, { a: 1 });
    expect(await decryptJson(s?.key as CryptoKey, sealed)).toEqual({ a: 1 });
  });

  it('deletes the database and the derived key after the limit', async () => {
    const ob = makeOutbox(fakeTransport().transport);
    await ob.addRecord({ label: 'x', method: 'POST', path: '/ipc/v1/tasks/t1/start' });
    const name = db.name;
    const state = await enforceOfflineGuard(db, now + OFFLINE_LIMIT_MS + 1);
    expect(state.status).toBe('expired');
    const reopened = openDb(name);
    expect(await reopened.outbox.count()).toBe(0);
    expect(await loadOfflineSession(reopened)).toBeUndefined();
    reopened.close();
  });

  it('deletes the database and the key on logout', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/auth/logout', () => undefined);
    const name = db.name;
    await signOutAndWipe(db, f.transport);
    expect(f.calls.some((c) => c.path === '/ipc/v1/auth/logout')).toBe(true);
    const reopened = openDb(name);
    expect(await loadOfflineSession(reopened)).toBeUndefined();
    reopened.close();
  });

  it('still wipes on logout when offline', async () => {
    const f = fakeTransport();
    f.on('POST', '/ipc/v1/auth/logout', () => {
      throw new NetworkError('offline');
    });
    const name = db.name;
    await signOutAndWipe(db, f.transport);
    const reopened = openDb(name);
    expect(await loadOfflineSession(reopened)).toBeUndefined();
    reopened.close();
  });
});
