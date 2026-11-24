import type { components } from '@ipc/contracts';
import { NetworkError, apiRequest, newIdempotencyKey } from '../../lib/api.js';
import { getCached, putCached } from '../../offline/cache.js';
import type { FieldDb } from '../../offline/db.js';
import type { Outbox } from '../../offline/outbox.js';
import type { CapturedPhoto } from '../capture/capture.js';

export type Task = components['schemas']['Task'];
export const MY_TASKS_KEY = ['tasks', 'mine'] as const;
export const taskKey = (id: string) => ['tasks', id] as const;
const CACHE = 'tasks:mine';

export interface MyTasks { items: Task[]; offline: boolean; updatedAt?: number }

/**
 * My tasks (listTasks view=mine). Online: fetched and kept in the encrypted device cache;
 * offline: the cached list, so the owner can keep working without network (Constitution VII).
 */
export async function loadMyTasks(db: FieldDb, key: CryptoKey): Promise<MyTasks> {
  try {
    const page = await apiRequest<{ items: Task[] }>('/ipc/v1/tasks?view=mine&limit=100');
    await putCached(db, key, CACHE, page.items);
    return { items: page.items, offline: false, updatedAt: Date.now() };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    const cached = await getCached<Task[]>(db, key, CACHE);
    if (!cached) throw e;
    return { items: cached.value, offline: true, updatedAt: cached.updatedAt };
  }
}

/** One task: from the server when online (fresh version for If-Match), else from the cached list. */
export async function loadTask(db: FieldDb, key: CryptoKey, id: string): Promise<{ task: Task; offline: boolean }> {
  try {
    const task = await apiRequest<Task>(`/ipc/v1/tasks/${id}`);
    const cached = (await getCached<Task[]>(db, key, CACHE))?.value ?? [];
    await putCached(db, key, CACHE, [...cached.filter((t) => t.id !== id), task]);
    return { task, offline: false };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    const task = (await getCached<Task[]>(db, key, CACHE))?.value.find((t) => t.id === id);
    if (!task) throw e;
    return { task, offline: true };
  }
}

/** Optimistic local copy after queueing a change (shown until the server answers). */
export async function rememberLocal(db: FieldDb, key: CryptoKey, task: Task): Promise<void> {
  const cached = (await getCached<Task[]>(db, key, CACHE))?.value ?? [];
  await putCached(db, key, CACHE, [...cached.filter((t) => t.id !== task.id), task]);
}

/**
 * startTask. Online it is sent at once, so an open dependency is shown immediately
 * (409 DEPENDENCY_OPEN naming the blocking task); offline it waits in the outbox with If-Match.
 */
export async function startTask(outbox: Outbox, task: Task, label: string): Promise<{ task?: Task; queued: boolean }> {
  try {
    const next = await apiRequest<Task>(`/ipc/v1/tasks/${task.id}/start`, { method: 'POST', ifMatch: String(task.v), idempotencyKey: newIdempotencyKey() });
    return { task: next, queued: false };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    await outbox.addRecord({ label, method: 'POST', path: `/ipc/v1/tasks/${task.id}/start`, ifMatch: String(task.v) });
    return { queued: true };
  }
}

/**
 * Upload proof through the outbox (Constitution VII order): every photo first (intent → PUT →
 * confirm, with its device SHA-256, time and GPS), then the submission with If-Match, which refers
 * to the photos by their outbox ids until they have server ids. A stale version comes back as 409
 * and the queue offers the differences view (FR-016).
 */
export async function queueProof(outbox: Outbox, task: Task, photos: CapturedPhoto[], note: string | undefined, labels: { photo: string; submit: string }): Promise<void> {
  const ids: string[] = [];
  for (const p of photos) {
    ids.push(await outbox.addEvidence({
      label: labels.photo,
      bytes: p.bytes,
      meta: {
        sha256: p.sha256, sizeBytes: p.sizeBytes, mime: p.mime, capturedAt: p.capturedAt, gps: p.gps, gpsUnavailable: p.gpsUnavailable,
        wardId: task.wardId, link: { type: 'task', id: task.id },
      },
    }));
  }
  await outbox.addRecord({
    label: labels.submit,
    method: 'POST',
    path: `/ipc/v1/tasks/${task.id}/evidence-submission`,
    body: { evidenceIds: ids.map((id) => ({ $evidence: id })), ...(note ? { note } : {}) },
    ifMatch: String(task.v),
    dependsOn: ids,
  });
}
