import { ApiError, NetworkError, isTransient, newIdempotencyKey, type HttpMethod, type Problem } from '../lib/api.js';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, type Bytes } from './crypto.js';
import type { AttentionReason, FieldDb, ItemKind, ItemStatus, OutboxRow } from './db.js';
import { MAX_ATTEMPTS, backoffDelay } from './sync.js';

/** Constitution VII order: evidence files, then assessment/task records, then decisions. */
const KIND_ORDER: Record<ItemKind, number> = { evidence: 0, record: 1, decision: 2 };

export interface TransportRequest {
  method: HttpMethod;
  body?: unknown;
  idempotencyKey: string;
  ifMatch?: string;
}

export interface Transport {
  request<T>(path: string, init: TransportRequest): Promise<T>;
  /** PUT to a signed storage URL (no cookies). */
  upload(url: string, method: string, headers: Record<string, string>, bytes: Bytes, mime: string): Promise<void>;
}

export interface EvidenceMeta {
  sha256: string;
  sizeBytes: number;
  mime: 'image/jpeg' | 'image/png' | 'application/pdf';
  capturedAt: string;
  gps: { lat: number; lng: number; accuracyM: number } | null;
  gpsUnavailable: boolean;
  wardId: string;
  link: { type: 'task' | 'question'; id: string };
}

interface EvidencePayload {
  label: string;
  meta: EvidenceMeta;
}

interface RequestPayload {
  label: string;
  method: Exclude<HttpMethod, 'GET'>;
  path: string;
  /** May contain `{ "$evidence": "<outbox item id>" }`, replaced by the server evidence id. */
  body?: unknown;
  ifMatch?: string;
}

export interface RequestInput extends RequestPayload {
  dependsOn?: string[];
}

export interface OutboxItemView {
  id: string;
  kind: ItemKind;
  label: string;
  status: ItemStatus;
  attention?: AttentionReason;
  problemCode?: string;
  readOnly: boolean;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  dependsOn: string[];
  /** Dependencies not yet sent; this item waits for them. */
  blockedBy: string[];
}

export interface ConflictView {
  label: string;
  path: string;
  mine: unknown;
  current: unknown;
  currentVersion?: number;
}

export interface FlushResult {
  sent: number;
  needsAttention: number;
  /** Earliest time a pending item becomes due again. */
  nextAttemptAt?: number;
  authRequired?: boolean;
}

interface OutboxOptions {
  db: FieldDb;
  key: CryptoKey;
  transport: Transport;
  deviceId: string;
  now?: () => number;
  random?: () => number;
  appVersion?: string;
}

interface IntentResponse {
  evidence: { id: string; state: string };
  upload: { url: string; method: string; headers?: Record<string, string> };
  alreadyUploaded?: boolean;
}

export class Outbox {
  private readonly db: FieldDb;
  private readonly key: CryptoKey;
  private readonly t: Transport;
  private readonly now: () => number;
  private readonly random: () => number;
  private flushing: Promise<FlushResult> | undefined;

  constructor(private readonly opts: OutboxOptions) {
    this.db = opts.db;
    this.key = opts.key;
    this.t = opts.transport;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  // ------------------------------------------------------------------ enqueue

  async addEvidence(input: { label: string; bytes: Bytes; meta: EvidenceMeta }): Promise<string> {
    const id = newIdempotencyKey();
    await this.db.files.put({ id, data: await encryptBytes(this.key, input.bytes) });
    const payload: EvidencePayload = { label: input.label, meta: input.meta };
    await this.insert(id, 'evidence', payload, [], { confirm: newIdempotencyKey() });
    return id;
  }

  addRecord(input: RequestInput): Promise<string> {
    return this.addRequest('record', input);
  }

  addDecision(input: RequestInput): Promise<string> {
    return this.addRequest('decision', input);
  }

  private async addRequest(kind: ItemKind, input: RequestInput): Promise<string> {
    const id = newIdempotencyKey();
    const { dependsOn = [], ...payload } = input;
    await this.insert(id, kind, payload, dependsOn, {});
    return id;
  }

  private async insert(id: string, kind: ItemKind, payload: unknown, dependsOn: string[], stepKeys: Record<string, string>) {
    const now = this.now();
    const last = await this.db.outbox.orderBy('seq').last();
    await this.db.outbox.add({
      id,
      seq: (last?.seq ?? 0) + 1,
      kind,
      status: 'pending',
      dependsOn,
      idempotencyKey: newIdempotencyKey(),
      stepKeys,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now,
      updatedAt: now,
      readOnly: false,
      payload: await encryptJson(this.key, payload),
      stage: kind === 'evidence' ? 'new' : undefined,
    });
  }

  // ------------------------------------------------------------------ read

  private async rows(): Promise<OutboxRow[]> {
    const rows = await this.db.outbox.toArray();
    return rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.seq - b.seq);
  }

  async list(): Promise<OutboxItemView[]> {
    const rows = await this.rows();
    const status = new Map(rows.map((r) => [r.id, r.status]));
    return Promise.all(
      rows.map(async (r) => {
        const p = await decryptJson<{ label: string }>(this.key, r.payload);
        return {
          id: r.id,
          kind: r.kind,
          label: p.label,
          status: r.status,
          attention: r.attention,
          problemCode: r.problemCode,
          readOnly: r.readOnly,
          attempts: r.attempts,
          nextAttemptAt: r.nextAttemptAt,
          createdAt: r.createdAt,
          dependsOn: r.dependsOn,
          blockedBy: r.status === 'pending' ? r.dependsOn.filter((d) => status.get(d) !== 'sent') : [],
        };
      }),
    );
  }

  async getConflict(id: string): Promise<ConflictView | undefined> {
    const row = await this.db.outbox.get(id);
    if (!row?.conflict) return undefined;
    const p = await decryptJson<RequestPayload>(this.key, row.payload);
    const problem = await decryptJson<Problem & { current?: unknown; currentVersion?: number }>(this.key, row.conflict);
    return { label: p.label, path: p.path, mine: p.body, current: problem.current, currentVersion: problem.currentVersion };
  }

  // ------------------------------------------------------------------ user actions

  private async editable(id: string): Promise<OutboxRow> {
    const row = await this.db.outbox.get(id);
    if (!row) throw new Error(`Outbox item ${id} not found`);
    if (row.readOnly) throw new Error(`Outbox item ${id} is read-only (access changed)`);
    return row;
  }

  /** Re-apply the user's change on top of the server's current version (after 409). */
  async reapply(id: string, change: { body: unknown; ifMatch?: string }): Promise<void> {
    const row = await this.editable(id);
    if (row.kind === 'evidence') throw new Error('Evidence items cannot be re-applied');
    const p = await decryptJson<RequestPayload>(this.key, row.payload);
    const next: RequestPayload = { ...p, body: change.body, ifMatch: change.ifMatch ?? p.ifMatch };
    await this.db.outbox.update(id, {
      payload: await encryptJson(this.key, next),
      // A different body must use a new key, or the server answers IDEMPOTENCY_KEY_REUSED.
      idempotencyKey: newIdempotencyKey(),
      ...this.resetFields(),
    });
  }

  /** Try a stopped item again (after retries ran out). */
  async retry(id: string): Promise<void> {
    await this.editable(id);
    await this.db.outbox.update(id, this.resetFields());
  }

  /** Drop an unsent item (e.g. keep the server version after a conflict). Dependents stop and say why. */
  async discard(id: string): Promise<void> {
    const row = await this.editable(id);
    if (row.status === 'sent') return;
    await this.db.transaction('rw', [this.db.outbox, this.db.files], async () => {
      await this.db.outbox.delete(id);
      await this.db.files.delete(id);
      const dependents = await this.db.outbox.filter((r) => r.dependsOn.includes(id) && r.status === 'pending').toArray();
      for (const d of dependents) {
        await this.db.outbox.update(d.id, { status: 'needs_attention', attention: 'rejected', problemCode: 'DEPENDENCY_DISCARDED', updatedAt: this.now() });
      }
    });
  }

  private resetFields(): Partial<OutboxRow> {
    return { status: 'pending', attempts: 0, nextAttemptAt: 0, attention: undefined, problemCode: undefined, conflict: undefined, updatedAt: this.now() };
  }

  // ------------------------------------------------------------------ sending

  /** Sends every due item in order. Concurrent calls share one run. */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, needsAttention: 0 };
    const rows = await this.rows();
    const status = new Map(rows.map((r) => [r.id, r.status]));
    const refs = new Map(rows.filter((r) => r.serverRef).map((r) => [r.id, r.serverRef as string]));

    for (const row of rows) {
      if (row.status !== 'pending') continue;
      if (row.dependsOn.some((d) => status.get(d) !== 'sent')) continue; // blocked by its dependency only
      if (row.nextAttemptAt > this.now()) {
        result.nextAttemptAt = Math.min(result.nextAttemptAt ?? Infinity, row.nextAttemptAt);
        continue;
      }
      try {
        const ref = row.kind === 'evidence' ? await this.sendEvidence(row) : await this.sendRequest(row, refs);
        if (ref) refs.set(row.id, ref);
        await this.db.outbox.update(row.id, { status: 'sent', serverRef: ref, attention: undefined, updatedAt: this.now() });
        if (row.kind === 'evidence') await this.db.files.delete(row.id);
        status.set(row.id, 'sent');
        result.sent += 1;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          result.authRequired = true;
          break;
        }
        const next = await this.recordFailure(row, e);
        status.set(row.id, next.status);
        if (next.status === 'needs_attention') result.needsAttention += 1;
        else result.nextAttemptAt = Math.min(result.nextAttemptAt ?? Infinity, next.nextAttemptAt);
      }
    }
    return result;
  }

  private async recordFailure(row: OutboxRow, e: unknown): Promise<{ status: ItemStatus; nextAttemptAt: number }> {
    const now = this.now();
    const code = e instanceof ApiError ? e.code : e instanceof NetworkError ? 'NETWORK' : 'CLIENT_ERROR';
    let update: Partial<OutboxRow>;
    if (isTransient(e)) {
      const attempts = row.attempts + 1;
      update =
        attempts >= MAX_ATTEMPTS
          ? { attempts, status: 'needs_attention', attention: 'retries_exhausted', problemCode: code }
          : { attempts, nextAttemptAt: now + backoffDelay(attempts, this.random), problemCode: code };
    } else if (e instanceof ApiError && e.status === 403) {
      // Scope changed while offline: keep the item, read-only, and tell the user (spec edge case).
      update = { status: 'needs_attention', attention: 'access_changed', readOnly: true, problemCode: code };
    } else if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      update = { status: 'needs_attention', attention: 'conflict', problemCode: code, conflict: await encryptJson(this.key, e.problem) };
    } else {
      update = { status: 'needs_attention', attention: 'rejected', problemCode: code };
    }
    update.updatedAt = now;
    await this.db.outbox.update(row.id, update);
    return { status: update.status ?? 'pending', nextAttemptAt: update.nextAttemptAt ?? row.nextAttemptAt };
  }

  private async sendRequest(row: OutboxRow, refs: Map<string, string>): Promise<string | undefined> {
    const p = await decryptJson<RequestPayload>(this.key, row.payload);
    await this.t.request(p.path, {
      method: p.method,
      body: p.body === undefined ? undefined : resolveRefs(p.body, refs),
      idempotencyKey: row.idempotencyKey,
      ifMatch: p.ifMatch,
    });
    return undefined;
  }

  /** intent → PUT to the signed URL → confirmation; each step's progress is persisted. */
  private async sendEvidence(row: OutboxRow): Promise<string> {
    const p = await decryptJson<EvidencePayload>(this.key, row.payload);
    let ref = row.serverRef;
    let stage = row.stage ?? 'new';
    if (stage === 'new') {
      const res = await this.t.request<IntentResponse>('/ipc/v1/evidence/intents', {
        method: 'POST',
        body: { ...p.meta, deviceId: this.opts.deviceId },
        idempotencyKey: row.idempotencyKey,
      });
      ref = res.evidence.id;
      await this.db.outbox.update(row.id, { serverRef: ref, stage: 'intent' });
      if (res.evidence.state === 'confirmed') return ref;
      if (!res.alreadyUploaded) await this.upload(row.id, res.upload, p.meta.mime);
      stage = 'uploaded';
      await this.db.outbox.update(row.id, { stage });
    } else if (stage === 'intent') {
      // The signed URL may have expired: ask for a fresh one (new key: a new URL is a new result).
      const url = await this.t.request<IntentResponse['upload']>(`/ipc/v1/evidence/${ref}/upload-url`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      await this.upload(row.id, url, p.meta.mime);
      stage = 'uploaded';
      await this.db.outbox.update(row.id, { stage });
    }
    await this.t.request(`/ipc/v1/evidence/${ref}/confirmation`, {
      method: 'POST',
      idempotencyKey: row.stepKeys.confirm ?? row.idempotencyKey,
    });
    return ref as string;
  }

  private async upload(id: string, target: IntentResponse['upload'], mime: string): Promise<void> {
    const file = await this.db.files.get(id);
    if (!file) throw new ApiError(422, { code: 'VALIDATION_FAILED', title: 'Evidence file missing on device', status: 422 });
    const bytes = await decryptBytes(this.key, file.data);
    await this.t.upload(target.url, target.method, target.headers ?? {}, bytes, mime);
  }

  // ------------------------------------------------------------------ telemetry (FR-037)

  async queueStatus() {
    const rows = await this.db.outbox.toArray();
    const pending = rows.filter((r) => r.status === 'pending');
    const oldest = pending.reduce<number | undefined>((m, r) => (m === undefined || r.createdAt < m ? r.createdAt : m), undefined);
    return {
      oldestPendingAt: oldest === undefined ? null : new Date(oldest).toISOString(),
      pendingCount: pending.length,
      failedCount: rows.filter((r) => r.status === 'needs_attention').length,
      reportedAt: new Date(this.now()).toISOString(),
      ...(this.opts.appVersion ? { appVersion: this.opts.appVersion } : {}),
    };
  }

  async reportQueueStatus(): Promise<void> {
    await this.t.request(`/ipc/v1/devices/${this.opts.deviceId}/queue-status`, {
      method: 'PUT',
      body: await this.queueStatus(),
      idempotencyKey: newIdempotencyKey(),
    });
  }
}

/** Replaces `{ $evidence: localId }` markers with the server evidence id. */
export function resolveRefs(value: unknown, refs: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, refs));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$evidence === 'string' && Object.keys(obj).length === 1) {
      const ref = refs.get(obj.$evidence);
      if (!ref) throw new Error(`Evidence ${obj.$evidence} has no server id yet`);
      return ref;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, refs)]));
  }
  return value;
}
