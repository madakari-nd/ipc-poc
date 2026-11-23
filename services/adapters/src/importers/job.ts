import { Schema, type Connection, type Model, type Types } from 'mongoose';

export type ImportKind = 'facility' | 'hr';
export type ImportStatus = 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed';

export interface ImportCounts {
  rows: number; created: number; updated: number; deactivated: number; failed: number; tasksNeedingReassignment: number;
}
export interface RowError { row: number; code: string; message: string }

export interface ImportJobDoc {
  _id: Types.ObjectId; v: number; kind: ImportKind; status: ImportStatus; dryRun: boolean; fileSha256: string;
  counts: ImportCounts; rowErrors: RowError[]; substitutions: string[]; requestedBy: string;
  startedAt?: Date; finishedAt?: Date; createdAt: Date; updatedAt: Date;
}

/** HR staff map: staff id → ELEVATE user (makes the HR import an upsert by staff code). */
export interface HrStaffDoc {
  _id: Types.ObjectId; staffId: string; elevateUserId: string; email: string; name: string; role: string;
  status: 'active' | 'left'; elevateRole?: string; mentorRequestId?: number; createdAt: Date; updatedAt: Date;
}

export const MAX_ROW_ERRORS = 1000;

const opts = (collection: string) => ({
  collection, timestamps: true, versionKey: false as const, autoIndex: false, autoCreate: false, strict: 'throw' as const,
});

export interface ImportModels { Job: Model<ImportJobDoc>; Staff: Model<HrStaffDoc> }

/** Models on the adapters' connection (`ipc_<profile>`); collections/indexes come from migrations. */
export function createImportModels(conn: Connection): ImportModels {
  const counts = new Schema({
    rows: { type: Number, default: 0 }, created: { type: Number, default: 0 }, updated: { type: Number, default: 0 },
    deactivated: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, tasksNeedingReassignment: { type: Number, default: 0 },
  }, { _id: false });
  const job = new Schema<ImportJobDoc>({
    v: { type: Number, default: 0 },
    kind: { type: String, enum: ['facility', 'hr'], required: true },
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'partially_succeeded', 'failed'], required: true },
    dryRun: { type: Boolean, default: false },
    fileSha256: { type: String, match: /^[a-f0-9]{64}$/, required: true },
    counts: { type: counts, default: () => ({}) },
    rowErrors: [new Schema({ row: Number, code: { type: String, maxlength: 64 }, message: { type: String, maxlength: 300 } }, { _id: false })],
    substitutions: [{ type: String, maxlength: 300 }],
    requestedBy: { type: String, maxlength: 64, required: true },
    startedAt: Date,
    finishedAt: Date,
  }, opts('import_jobs'));
  const staff = new Schema<HrStaffDoc>({
    staffId: { type: String, maxlength: 64, required: true },
    elevateUserId: { type: String, maxlength: 64, required: true },
    email: { type: String, maxlength: 254, required: true },
    name: { type: String, maxlength: 200, required: true },
    role: { type: String, maxlength: 32, required: true },
    status: { type: String, enum: ['active', 'left'], required: true },
    elevateRole: { type: String, maxlength: 32 },
    mentorRequestId: Number,
  }, opts('hr_staff'));
  return {
    Job: (conn.models.ImportJob as Model<ImportJobDoc> | undefined) ?? conn.model<ImportJobDoc>('ImportJob', job),
    Staff: (conn.models.HrStaff as Model<HrStaffDoc> | undefined) ?? conn.model<HrStaffDoc>('HrStaff', staff),
  };
}

/** Contract `ImportJob`. */
export function toImportJobDto(j: ImportJobDoc) {
  return {
    id: String(j._id), v: j.v, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString(),
    kind: j.kind, status: j.status, dryRun: j.dryRun, fileSha256: j.fileSha256,
    counts: {
      rows: j.counts.rows, created: j.counts.created, updated: j.counts.updated, deactivated: j.counts.deactivated,
      failed: j.counts.failed, tasksNeedingReassignment: j.counts.tasksNeedingReassignment,
    },
    rowErrors: j.rowErrors.map((e) => ({ row: e.row, code: e.code, message: e.message })),
    substitutions: [...j.substitutions],
    ...(j.startedAt ? { startedAt: j.startedAt.toISOString() } : {}),
    ...(j.finishedAt ? { finishedAt: j.finishedAt.toISOString() } : {}),
  };
}
export type ImportJobDto = ReturnType<typeof toImportJobDto>;

/** Mutable result an importer fills while it runs. */
export class ImportReport {
  counts: ImportCounts = { rows: 0, created: 0, updated: 0, deactivated: 0, failed: 0, tasksNeedingReassignment: 0 };
  rowErrors: RowError[] = [];
  substitutions = new Set<string>();

  fail(row: number, code: string, message: string) {
    this.counts.failed += 1;
    if (this.rowErrors.length < MAX_ROW_ERRORS) this.rowErrors.push({ row, code: code.slice(0, 64), message: message.slice(0, 300) });
  }

  status(): ImportStatus {
    if (this.counts.failed === 0) return 'succeeded';
    return this.counts.failed >= this.counts.rows ? 'failed' : 'partially_succeeded';
  }
}
