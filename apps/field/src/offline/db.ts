import Dexie, { type Table } from 'dexie';
import type { Sealed } from './crypto.js';

export type ItemKind = 'evidence' | 'record' | 'decision';
export type ItemStatus = 'pending' | 'sent' | 'needs_attention';
export type AttentionReason = 'access_changed' | 'conflict' | 'rejected' | 'retries_exhausted';
export type EvidenceStage = 'new' | 'intent' | 'uploaded';

/** Outbox row. Only routing/status fields are plain; the payload (labels, bodies) is encrypted. */
export interface OutboxRow {
  id: string;
  seq: number;
  kind: ItemKind;
  status: ItemStatus;
  dependsOn: string[];
  /** Idempotency-Key for the item's main write; replaced only when the user re-applies a change. */
  idempotencyKey: string;
  /** Keys for secondary steps (evidence confirmation). */
  stepKeys: Record<string, string>;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  attention?: AttentionReason;
  problemCode?: string;
  readOnly: boolean;
  payload: Sealed;
  /** Server reference once sent (e.g. the evidence id). */
  serverRef?: string;
  stage?: EvidenceStage;
  /** Encrypted ConflictProblem body for the differences view (FR-016). */
  conflict?: Sealed;
}

export interface FileRow {
  id: string;
  data: Sealed;
}

export interface CacheRow {
  key: string;
  data: Sealed;
  updatedAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export const DB_NAME = 'ipc-field';

export class FieldDb extends Dexie {
  outbox!: Table<OutboxRow, string>;
  files!: Table<FileRow, string>;
  cache!: Table<CacheRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      outbox: 'id, seq, kind, status',
      files: 'id',
      cache: 'key',
      meta: 'key',
    });
  }
}

export function openDb(name: string = DB_NAME): FieldDb {
  return new FieldDb(name);
}
