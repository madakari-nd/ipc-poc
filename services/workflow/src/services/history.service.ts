import { Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import type { ServiceIdentity } from '../auth/service-jwt.js';
import { toChainFields } from '../ledger/ledger.repository.js';
import { toLedgerRecordDto, type LedgerService } from '../ledger/ledger.service.js';
import {
  AssessmentContextModel, EscalationModel, FacilityModel, LedgerRecordModel, PlanModel, SupportRequestModel, TaskModel, WardModel,
  type LedgerRecordDoc, type LedgerSubjectType,
} from '../domain/models/index.js';
import type { ScopeService } from './scope.service.js';

/** Where an entity sits; `global` = programme-wide configuration (cycles, checklists, clock…). */
interface Location { global?: boolean; facilityId?: string; wardId?: string; districtCode?: string }

/** Subjects that belong to no single place: only a state-level scope may read their history. */
const GLOBAL_SUBJECTS = new Set<LedgerSubjectType>([
  'programme', 'cycle', 'scope_assignment', 'checklist_version', 'risk_default', 'escalation_rule', 'clock', 'import_job', 'retention_policy',
]);

const EDGE_ISSUER = 'ipc-edge';
const oid = (id: string) => (Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/.test(id) ? new Types.ObjectId(id) : null);

export interface LedgerPage { items: ReturnType<typeof toLedgerRecordDto>[]; nextCursor: string | null }

export const encodeCursor = (seq: number) => Buffer.from(`s:${seq}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const m = /^s:(\d{1,12})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m) throw Problem.badRequest('VALIDATION_FAILED', 'cursor is not valid');
  return Number(m[1]);
}

/**
 * Entity history and ledger verification (T065, FR-031). Scope is always the server-derived scope
 * of the acting user (FR-028): the role in the service token only picks which of the user's own
 * assignments apply. Unknown ids and out-of-scope entities answer SCOPE_DENIED alike.
 */
export class HistoryService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly scope: ScopeService,
  ) {}

  private async facility(id: unknown): Promise<Location | null> {
    const f = await FacilityModel.findById(id).select({ districtCode: 1 }).lean();
    return f ? { facilityId: String(f._id), districtCode: f.districtCode } : null;
  }

  private async ward(id: unknown): Promise<Location | null> {
    const w = await WardModel.findById(id).select({ facilityId: 1 }).lean();
    if (!w) return null;
    const f = await this.facility(w.facilityId);
    return { ...f, wardId: String(w._id) };
  }

  private async task(id: unknown): Promise<Location | null> {
    const t = await TaskModel.findById(id).select({ planId: 1 }).lean();
    if (!t) return null;
    const p = await PlanModel.findById(t.planId).select({ wardId: 1 }).lean();
    return p ? this.ward(p.wardId) : null;
  }

  /** Location of the subject, or null when it does not exist (or cannot be placed). */
  async locate(type: LedgerSubjectType, id: string, caller: ServiceIdentity): Promise<Location | null> {
    if (GLOBAL_SUBJECTS.has(type)) return { global: true };
    // Evidence is owned by the Edge, which runs its evidence scope guard before asking.
    if (type === 'evidence') return caller.iss === EDGE_ISSUER ? {} : null;
    const _id = oid(id);
    if (!_id) return null;
    switch (type) {
      case 'facility': return this.facility(_id);
      case 'ward': return this.ward(_id);
      case 'plan': {
        const p = await PlanModel.findById(_id).select({ wardId: 1 }).lean();
        return p ? this.ward(p.wardId) : null;
      }
      case 'task': return this.task(_id);
      case 'escalation': {
        const e = await EscalationModel.findById(_id).select({ taskId: 1 }).lean();
        return e ? this.task(e.taskId) : null;
      }
      case 'assessment': {
        const a = await AssessmentContextModel.findById(_id).select({ wardId: 1 }).lean();
        return a ? this.ward(a.wardId) : null;
      }
      case 'support_request': {
        const s = await SupportRequestModel.findById(_id).select({ wardId: 1 }).lean();
        return s ? this.ward(s.wardId) : null;
      }
      default: return null;
    }
  }

  /** Does the acting user's own assignment for the claimed role cover the location? */
  async covers(caller: ServiceIdentity, loc: Location): Promise<boolean> {
    const act = caller.act!;
    let assignments;
    try {
      assignments = (await this.scope.effective(act.sub)).assignments.filter((a) => a.role === act.role);
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return false;
      throw err;
    }
    // Delegated (evidence): the Edge has checked the item; the role must still be a real assignment.
    if (!loc.global && !loc.facilityId && !loc.wardId) return assignments.length > 0;
    return assignments.some(({ scope: s }) => {
      if (s.level === 'state') return true;
      if (loc.global) return false;
      switch (s.level) {
        case 'district': return !!loc.districtCode && s.districtCode === loc.districtCode;
        case 'facility': return !!loc.facilityId && (s.facilityId === loc.facilityId || (s.facilityIds ?? []).includes(loc.facilityId));
        case 'wards': return !!loc.wardId && (s.wardIds ?? []).includes(loc.wardId);
        default: return false;
      }
    });
  }

  async entityLedger(caller: ServiceIdentity, type: LedgerSubjectType, id: string, o: { cursor?: string; limit: number }): Promise<LedgerPage> {
    const after = decodeCursor(o.cursor);
    const loc = await this.locate(type, id, caller);
    if (!loc || !(await this.covers(caller, loc))) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    const docs = await LedgerRecordModel.find({ 'subject.type': type, 'subject.id': id, seq: { $gt: after } })
      .sort({ seq: 1 })
      .limit(o.limit + 1)
      .lean<LedgerRecordDoc[]>();
    const page = docs.slice(0, o.limit);
    return {
      items: page.map((d) => toLedgerRecordDto(toChainFields(d))),
      nextCursor: docs.length > o.limit ? encodeCursor(page.at(-1)!.seq) : null,
    };
  }

  /** verifyLedger: STATE_ADMIN with a real state assignment. */
  async verify(caller: ServiceIdentity, fromSeq: number) {
    if (!(await this.covers(caller, { global: true }))) throw Problem.forbidden('SCOPE_DENIED', 'Only the state administrator can verify the ledger.');
    const r = await this.ledger.verify(fromSeq);
    return { ...r, verifiedAt: r.verifiedAt.toISOString() };
  }
}
