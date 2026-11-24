import { Problem, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { LedgerRecordModel, PlanModel, RetentionPolicyModel, type RetentionPolicy } from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';

const YEAR_MS = 365 * 86_400_000;

export interface RetentionPolicyView {
  id: string; v: number; evidenceYearsAfterPlanClosure: number; auditYears: number;
  otherYearsAfterProgrammeEnd: number; purgeMode: 'dry_run' | 'enforce'; updatedBy: string;
  updatedAt: string; createdAt: string;
}

export function toRetentionPolicyDto(p: RetentionPolicy): RetentionPolicyView {
  return {
    id: String(p._id), v: p.v, evidenceYearsAfterPlanClosure: p.evidenceYearsAfterPlanClosure, auditYears: p.auditYears,
    otherYearsAfterProgrammeEnd: p.otherYearsAfterProgrammeEnd, purgeMode: p.purgeMode, updatedBy: p.updatedBy,
    updatedAt: p.updatedAt.toISOString(), createdAt: p.createdAt.toISOString(),
  };
}

/** What one dry-run scan would delete, per governed class (NFR-010). */
export interface RetentionScan {
  runAt: string;
  policy: RetentionPolicyView;
  evidence: { planClosedBefore: string; count: number; planIds: string[] };
  audit: { olderThan: string; count: number };
  other: { programmeEndedBefore: string; count: number };
  mode: 'dry_run' | 'enforce';
}

/**
 * Data retention (T128, NFR-010, FR-031). Defaults per proposal A6: evidence 3 years after plan
 * closure, audit 7 years, other records 5 years after programme end. The POC runs purges in
 * `dry_run` — the daily job only reports what it WOULD delete and records each purge decision in the
 * ledger. `enforce` is available for the pilot so the mechanism is real, but nothing is deleted in
 * the POC without turning it on. Patient-showing media is governed by FR-032 (immediate), not here.
 */
export class RetentionService {
  constructor(
    private readonly d: { ledger: LedgerService; profile: string; now?: () => Date; logger?: Logger },
  ) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  async get(): Promise<RetentionPolicyView> {
    const p = await RetentionPolicyModel.findOne({ profile: this.d.profile }).lean<RetentionPolicy>();
    if (!p) throw Problem.notFound('No retention policy for this profile yet');
    return toRetentionPolicyDto(p);
  }

  async getOrCreateDefault(): Promise<RetentionPolicyView> {
    const existing = await RetentionPolicyModel.findOne({ profile: this.d.profile }).lean<RetentionPolicy>();
    if (existing) return toRetentionPolicyDto(existing);
    const [doc] = await RetentionPolicyModel.create([{
      profile: this.d.profile, evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5,
      purgeMode: 'dry_run', updatedBy: 'system', v: 0,
    }]);
    return toRetentionPolicyDto(doc!.toObject() as RetentionPolicy);
  }

  /**
   * Saves the policy; `retention.changed` ledger record with before/after fingerprints in the same
   * transaction (contract setRetentionPolicy). If-Match "0" creates a missing policy.
   */
  async set(
    input: { evidenceYearsAfterPlanClosure: number; auditYears: number; otherYearsAfterProgrammeEnd: number; purgeMode: 'dry_run' | 'enforce'; reason?: string },
    ifMatch: number | undefined,
    actor: LedgerActor,
  ): Promise<RetentionPolicyView> {
    const v = ifMatch ?? 0;
    const cur = await RetentionPolicyModel.findOne({ profile: this.d.profile }).lean<RetentionPolicy>();
    if ((cur?.v ?? 0) !== v) {
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this policy since you opened it', {
        currentVersion: cur?.v ?? 0,
        current: cur ? toRetentionPolicyDto(cur) : null,
      });
    }
    const fields = {
      evidenceYearsAfterPlanClosure: input.evidenceYearsAfterPlanClosure,
      auditYears: input.auditYears,
      otherYearsAfterProgrammeEnd: input.otherYearsAfterProgrammeEnd,
      purgeMode: input.purgeMode,
      updatedBy: actor.userId,
    };
    return withTx(async (session) => {
      const u = cur
        ? await RetentionPolicyModel.findOneAndUpdate({ _id: cur._id, v }, { $set: fields, $inc: { v: 1 } }, { new: true, session, lean: true })
        : (await RetentionPolicyModel.create([{ profile: this.d.profile, ...fields, v: 0 }], { session }))[0]!.toObject();
      if (!u) {
        throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this policy since you opened it', { currentVersion: cur?.v ?? 0, current: cur ? toRetentionPolicyDto(cur) : null });
      }
      const dto = toRetentionPolicyDto(u as RetentionPolicy);
      await this.d.ledger.append({
        actor, action: 'retention.changed', subject: { type: 'retention_policy', id: dto.id },
        reason: (input.reason ?? 'Retention policy updated').slice(0, 500),
        ...(cur ? { beforeHash: contentHash(pick(cur)) } : {}), afterHash: contentHash(pick(u as RetentionPolicy)),
      }, session);
      return dto;
    });
  }

  /**
   * Scans for records past their retention period. In `dry_run` (the POC default) it reports what it
   * would delete; in `enforce` it actually deletes programme-owned records (never the append-only
   * ledger — that stays for the audit period, and is only reported). Every purge decision is a
   * `retention.purge` ledger record (NFR-010).
   */
  async scan(_reason = 'scheduled daily scan'): Promise<RetentionScan> {
    const policy = await this.getOrCreateDefault();
    const now = this.now();
    const mode = policy.purgeMode;
    const log = this.d.logger;

    // ---- evidence: plans closed more than evidenceYearsAfterPlanClosure ago
    const evidenceCutoff = new Date(now.getTime() - policy.evidenceYearsAfterPlanClosure * YEAR_MS);
    const closedPlans = await PlanModel.find({ status: 'closed', approvedAt: { $lte: evidenceCutoff } }, { _id: 1 }).lean<{ _id: unknown }[]>();
    const evidence: RetentionScan['evidence'] = { planClosedBefore: evidenceCutoff.toISOString(), count: closedPlans.length, planIds: closedPlans.map((p) => String(p._id)) };

    // ---- audit: ledger records older than auditYears (reported only; the ledger is never deleted)
    const auditCutoff = new Date(now.getTime() - policy.auditYears * YEAR_MS);
    const auditCount = await LedgerRecordModel.countDocuments({ at: { $lt: auditCutoff } });
    const audit = { olderThan: auditCutoff.toISOString(), count: auditCount };

    // ---- other: programme records older than otherYearsAfterProgrammeEnd after programme end.
    // The POC keeps no programme-end timestamp in a single place; the oldest active cycle is used as
    // a conservative anchor. Programmes have no end date yet, so this stays 0 (reported).
    const other = { programmeEndedBefore: new Date(now.getTime() - policy.otherYearsAfterProgrammeEnd * YEAR_MS).toISOString(), count: 0 };

    const scan: RetentionScan = { runAt: now.toISOString(), policy, evidence, audit, other, mode };

    // Record the purge decision (dry run: only what WOULD be purged; enforce: actually purge).
    await withTx(async (session) => {
      await this.d.ledger.append({
        actor: { userId: 'system', role: 'SYSTEM' },
        action: 'retention.purge',
        subject: { type: 'retention_policy', id: scan.policy.id },
        reason: `${mode}: ${evidence.count} closed plans, ${audit.count} audit records older than ${policy.auditYears}y, ${other.count} other records`.slice(0, 500),
      }, session);
      if (mode === 'enforce') {
        for (const p of evidence.planIds) {
          await PlanModel.deleteOne({ _id: p }, { session });
          await this.d.ledger.append({
            actor: { userId: 'system', role: 'SYSTEM' }, action: 'retention.purge', subject: { type: 'plan', id: p },
            reason: `purged (evidence retention ${policy.evidenceYearsAfterPlanClosure}y after closure)`,
          }, session);
        }
      }
    });
    log?.info({ mode, evidence: evidence.count, audit: audit.count, other: other.count }, 'retention scan completed');
    return scan;
  }
}

/** The hashed fields of a policy (stable input for before/after fingerprints). */
function pick(p: RetentionPolicy) {
  return {
    evidenceYearsAfterPlanClosure: p.evidenceYearsAfterPlanClosure,
    auditYears: p.auditYears,
    otherYearsAfterProgrammeEnd: p.otherYearsAfterProgrammeEnd,
    purgeMode: p.purgeMode,
    updatedBy: p.updatedBy,
  };
}
