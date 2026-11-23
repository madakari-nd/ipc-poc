import { Schema, type Types } from 'mongoose';
import type { LedgerRecordFields } from '../ledger-chain.js';
import { defineSchema, elevateId, modelFor, text } from './base.js';

export const LEDGER_SUBJECT_TYPES = [
  'programme', 'facility', 'ward', 'cycle', 'scope_assignment', 'checklist_version', 'risk_default', 'escalation_rule',
  'assessment', 'evidence', 'plan', 'task', 'escalation', 'support_request', 'clock', 'import_job', 'retention_policy',
] as const;
export type LedgerSubjectType = (typeof LEDGER_SUBJECT_TYPES)[number];

export const ACTOR_ROLES = [
  'STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR', 'SYSTEM',
] as const;

const sha256 = { type: String, match: /^[a-f0-9]{64}$/, maxlength: 64 };

// ---- LedgerRecord (§8): append-only. `at` is the creation time, so no createdAt/updatedAt.
export interface LedgerRecordDoc extends LedgerRecordFields { _id: Types.ObjectId; v: number }

const ledgerSchema = defineSchema<LedgerRecordDoc>('ledger', {
  seq: { type: Number, required: true, min: 1 },
  at: { type: Date, required: true },
  programmeAt: { type: Date, required: true },
  actor: {
    type: new Schema({ userId: elevateId(true), role: text({ required: true, enum: ACTOR_ROLES }) }, { _id: false, strict: 'throw' }),
    required: true,
  },
  action: { type: String, required: true, match: /^[a-z_]+\.[a-z_]+$/, maxlength: 64 },
  subject: {
    // `type` is a field name here, so `$type` is the Mongoose type key.
    type: new Schema(
      { type: { $type: String, required: true, enum: [...LEDGER_SUBJECT_TYPES] }, id: { $type: String, required: true, maxlength: 64 } },
      { _id: false, strict: 'throw', typeKey: '$type' },
    ),
    required: true,
  },
  reason: text(),
  beforeHash: sha256,
  afterHash: sha256,
  correlationId: { type: String, required: true, minlength: 1, maxlength: 64 },
  prevHash: { ...sha256, required: true },
  hash: { ...sha256, required: true },
}, { timestamps: false });

/**
 * Application code never updates or deletes ledger records (Constitution IV). The database role
 * (migration 0002) enforces the same thing at the server; these hooks fail fast in code.
 */
const MUTATIONS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const;
for (const op of MUTATIONS) {
  ledgerSchema.pre(op as never, function refuse() {
    throw new Error(`ledger is append-only: ${op} refused`);
  });
}
ledgerSchema.pre('save', function refuseUpdate() {
  if (!this.isNew) throw new Error('ledger is append-only: update refused');
});

export const LedgerRecordModel = modelFor<LedgerRecordDoc>('LedgerRecord', ledgerSchema);

// ---- Counter: monotonic sequences (ledger seq), incremented inside the append transaction
export interface CounterDoc { _id: string; seq: number }
export const CounterModel = modelFor<CounterDoc>(
  'Counter',
  new Schema<CounterDoc>(
    { _id: { type: String, required: true }, seq: { type: Number, required: true, min: 0 } },
    { collection: 'counters', versionKey: false, autoIndex: false, autoCreate: false, strict: 'throw' },
  ),
);

// ---- RetentionPolicy (§8): single document per profile
export interface RetentionPolicy {
  _id: Types.ObjectId; v: number; profile: string; evidenceYearsAfterPlanClosure: number; auditYears: number;
  otherYearsAfterProgrammeEnd: number; purgeMode: 'dry_run' | 'enforce'; updatedBy: string; createdAt: Date; updatedAt: Date;
}
export const RetentionPolicyModel = modelFor<RetentionPolicy>('RetentionPolicy', defineSchema('retention_policy', {
  profile: text({ required: true, enum: ['dev', 'test', 'uat', 'prod'] }),
  evidenceYearsAfterPlanClosure: { type: Number, default: 3, min: 1, max: 50 },
  auditYears: { type: Number, default: 7, min: 1, max: 50 },
  otherYearsAfterProgrammeEnd: { type: Number, default: 5, min: 1, max: 50 },
  purgeMode: text({ required: true, enum: ['dry_run', 'enforce'] }),
  updatedBy: elevateId(true),
}));
