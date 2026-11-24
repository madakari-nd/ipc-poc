import { Types, type ClientSession } from 'mongoose';
import { Problem } from '@ipc/platform';
import {
  buildFormBundle,
  previousCycle,
  releaseStateFor,
  statusMove,
  type AssessmentStatus,
  type AssessorType,
  type BundleQuestion,
  type BundleSection,
} from '../domain/assessment.js';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  AssessmentContextModel,
  ChecklistVersionModel,
  CycleModel,
  WardModel,
  type AssessmentContext,
  type ChecklistVersion,
  type Cycle,
  type Ward,
} from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import { visibleFacilityIds, type ActorScope } from './admin.service.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';

export interface ContextUpsert {
  elevateObservationId: string;
  submissionNumber?: number;
  wardId: string;
  facilityId: string;
  cycleId: string;
  checklistVersionId: string;
  assessorUserId: string;
  assessorType: AssessorType;
  declaration?: { accepted: true; at: Date };
  status: AssessmentStatus;
  evidenceIds?: string[];
  bundleHash?: string;
}

export interface ListQuery {
  view: 'assigned' | 'all';
  wardId?: string;
  cycleId?: string;
  status?: AssessmentStatus;
  releaseState?: 'n/a' | 'held' | 'released';
  cursor?: string;
  limit: number;
}

/** Roles that see hospital results; held external results stay hidden from them (FR-024a). */
const HOSPITAL_ROLES = new Set(['IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE']);
const IDENTITY: (keyof ContextUpsert)[] = ['elevateObservationId', 'wardId', 'facilityId', 'cycleId', 'checklistVersionId', 'assessorUserId', 'assessorType'];

const iso = (d?: Date | null) => (d ? d.toISOString() : undefined);

/** Contract `AssessmentContext`. */
export function toAssessmentDto(d: AssessmentContext, checklistVersion?: number) {
  const bySection = d.scores?.bySection instanceof Map ? Object.fromEntries(d.scores.bySection) : (d.scores?.bySection as Record<string, number> | undefined);
  return {
    id: String(d._id),
    v: d.v,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    elevateObservationId: d.elevateObservationId,
    elevateSubmissionId: d.elevateSubmissionId,
    ...(d.submissionNumber ? { submissionNumber: d.submissionNumber } : {}),
    wardId: String(d.wardId),
    facilityId: String(d.facilityId),
    cycleId: String(d.cycleId),
    checklistVersionId: String(d.checklistVersionId),
    ...(checklistVersion ? { checklistVersion } : {}),
    assessorUserId: d.assessorUserId,
    assessorType: d.assessorType,
    isBaselineForCycle: d.isBaselineForCycle,
    ...(d.baselineOfId ? { baselineOfId: String(d.baselineOfId) } : {}),
    ...(d.declaration?.accepted ? { declaration: { accepted: true as const, at: iso(d.declaration.at)! } } : {}),
    status: d.status,
    ...(d.completedAt ? { completedAt: iso(d.completedAt) } : {}),
    ...(d.scores && typeof d.scores.total === 'number' ? { scores: { total: d.scores.total, ...(bySection ? { bySection } : {}) } } : {}),
    failedQuestionKeys: [...(d.failedQuestionKeys ?? [])],
    releaseState: d.releaseState,
    ...(d.releasedBy ? { releasedBy: d.releasedBy } : {}),
    ...(d.releasedAt ? { releasedAt: iso(d.releasedAt) } : {}),
    evidenceIds: (d.evidenceIds ?? []).map(String),
  };
}
export type AssessmentDto = ReturnType<typeof toAssessmentDto>;

const oid = (s: string) => new Types.ObjectId(s);
const isOid = (s: string) => /^[a-f0-9]{24}$/.test(s);

/**
 * Programme context of ELEVATE ward assessments (T079, data-model §3, research E6/E7). Workflow
 * derives `isBaselineForCycle`, `baselineOfId` and `releaseState`; the Edge only reports what it
 * wrote to samiksha. Every change is ledgered in the same transaction (Constitution IV).
 */
export class AssessmentService {
  constructor(private readonly d: { ledger: LedgerService; now?: () => Date }) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private async checklistVersionOf(id: Types.ObjectId): Promise<number | undefined> {
    const c = await ChecklistVersionModel.findById(id, { version: 1 }).lean<{ version: number }>();
    return c?.version;
  }

  private async dto(d: AssessmentContext): Promise<AssessmentDto> {
    return toAssessmentDto(d, await this.checklistVersionOf(d.checklistVersionId));
  }

  /** First submitted/completed in (ward, cycle) other than `self`? */
  private async isBaseline(wardId: Types.ObjectId, cycleId: Types.ObjectId, self: Types.ObjectId | undefined, s: ClientSession) {
    const other = await AssessmentContextModel.exists({
      wardId,
      cycleId,
      status: { $in: ['submitted', 'completed'] },
      ...(self ? { _id: { $ne: self } } : {}),
    }).session(s);
    return !other;
  }

  /** Latest completed assessment of the ward in the previous cycle (also the US7 comparison baseline). */
  async defaultBaselineOf(wardId: Types.ObjectId, cycle: Pick<Cycle, '_id' | 'startsAt'>, s?: ClientSession): Promise<Types.ObjectId | undefined> {
    const cycles = await CycleModel.find({}, { startsAt: 1 }).session(s ?? null).lean<Cycle[]>();
    const prev = previousCycle(cycles, cycles.find((c) => String(c._id) === String(cycle._id)) ?? cycle);
    if (!prev) return undefined;
    const last = await AssessmentContextModel.findOne({ wardId, cycleId: prev._id, status: 'completed' }, { _id: 1 })
      .sort({ completedAt: -1 })
      .session(s ?? null)
      .lean<{ _id: Types.ObjectId }>();
    return last?._id;
  }

  private async checkRefs(b: ContextUpsert): Promise<{ cycle: Cycle }> {
    const errors: { path: string; message: string }[] = [];
    const [ward, cycle, checklist] = await Promise.all([
      WardModel.findById(b.wardId).lean<Ward>(),
      CycleModel.findById(b.cycleId).lean<Cycle>(),
      ChecklistVersionModel.findById(b.checklistVersionId, { status: 1 }).lean<Pick<ChecklistVersion, 'status'>>(),
    ]);
    if (!ward) errors.push({ path: 'wardId', message: 'unknown ward' });
    else if (String(ward.facilityId) !== b.facilityId) errors.push({ path: 'facilityId', message: 'the ward belongs to another facility' });
    if (!cycle) errors.push({ path: 'cycleId', message: 'unknown cycle' });
    if (!checklist) errors.push({ path: 'checklistVersionId', message: 'unknown checklist version' });
    else if (checklist.status === 'draft') errors.push({ path: 'checklistVersionId', message: 'is a draft' });
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'The assessment references are not valid', { errors });
    return { cycle: cycle! };
  }

  /**
   * `internalUpsertAssessmentContext`: keyed on `elevateSubmissionId`. Creates (201) or moves the
   * status forward (200); the same status is a no-op; a regression is 409 INVALID_TRANSITION.
   */
  async upsertContext(elevateSubmissionId: string, b: ContextUpsert): Promise<{ created: boolean; dto: AssessmentDto }> {
    const { cycle } = await this.checkRefs(b);
    if (b.status !== 'draft' && !b.declaration?.accepted) {
      // A submission without the no-patient-data declaration is never recorded (FR-032).
      const existing = await AssessmentContextModel.findOne({ elevateSubmissionId }, { declaration: 1 }).lean<AssessmentContext>();
      if (!existing?.declaration?.accepted) throw Problem.unprocessable('DECLARATION_REQUIRED', 'Confirm the no-patient-data declaration');
    }
    const actor: LedgerActor = { userId: b.assessorUserId, role: b.assessorType === 'external' ? 'EXTERNAL_AUDITOR' : 'IPC_OFFICER' };
    try {
      return await this.upsertTx(elevateSubmissionId, b, cycle, actor);
    } catch (err) {
      // Two first writes raced on the unique submission id: the loser becomes an update.
      if ((err as { code?: number }).code === 11000) return this.upsertTx(elevateSubmissionId, b, cycle, actor);
      throw err;
    }
  }

  private upsertTx(elevateSubmissionId: string, b: ContextUpsert, cycle: Cycle, actor: LedgerActor) {
    return withTx(async (s) => {
      const cur = await AssessmentContextModel.findOne({ elevateSubmissionId }).session(s).lean<AssessmentContext>();
      const wardId = oid(b.wardId);
      const cycleId = oid(b.cycleId);
      const evidenceIds = (b.evidenceIds ?? []).map(oid);
      const now = this.now();

      if (!cur) {
        const [doc] = await AssessmentContextModel.create(
          [
            {
              elevateObservationId: b.elevateObservationId,
              elevateSubmissionId,
              ...(b.submissionNumber ? { submissionNumber: b.submissionNumber } : {}),
              wardId,
              facilityId: oid(b.facilityId),
              cycleId,
              checklistVersionId: oid(b.checklistVersionId),
              assessorUserId: b.assessorUserId,
              assessorType: b.assessorType,
              isBaselineForCycle: await this.isBaseline(wardId, cycleId, undefined, s),
              baselineOfId: await this.defaultBaselineOf(wardId, cycle, s),
              ...(b.declaration ? { declaration: b.declaration } : {}),
              status: b.status,
              ...(b.status === 'completed' ? { completedAt: now } : {}),
              failedQuestionKeys: [],
              releaseState: releaseStateFor(b.assessorType),
              evidenceIds,
              v: 0,
            },
          ],
          { session: s },
        );
        const created = doc!.toObject() as AssessmentContext;
        const subject = { type: 'assessment' as const, id: String(created._id) };
        await this.d.ledger.append({ actor, action: 'assessment.started', subject, afterHash: contentHash(toAssessmentDto(created)) }, s);
        if (b.status !== 'draft') await this.d.ledger.append({ actor, action: `assessment.${b.status}`, subject }, s);
        return { created: true, dto: toAssessmentDto(created) };
      }

      const changed = IDENTITY.filter((k) => String(b[k]) !== String((cur as unknown as Record<string, unknown>)[k]));
      if (changed.length) {
        throw Problem.unprocessable('VALIDATION_FAILED', 'This submission is already recorded with other details', {
          errors: changed.map((k) => ({ path: k, message: 'differs from the recorded assessment' })),
        });
      }
      const move = statusMove(cur.status, b.status);
      if (move === 'backward') {
        throw Problem.conflict('INVALID_TRANSITION', `The assessment is already ${cur.status}`, { current: toAssessmentDto(cur) });
      }
      if (move === 'same') return { created: false, dto: toAssessmentDto(cur) };

      const set: Record<string, unknown> = {
        status: b.status,
        isBaselineForCycle: await this.isBaseline(cur.wardId, cur.cycleId, cur._id, s),
        ...(b.declaration ? { declaration: b.declaration } : {}),
        ...(b.evidenceIds ? { evidenceIds } : {}),
        ...(b.submissionNumber ? { submissionNumber: b.submissionNumber } : {}),
        ...(b.status === 'completed' && !cur.completedAt ? { completedAt: now } : {}),
      };
      const next = await AssessmentContextModel.findOneAndUpdate({ _id: cur._id, v: cur.v }, { $set: set, $inc: { v: 1 } }, { new: true, session: s, lean: true });
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'The assessment changed meanwhile; try again');
      const dto = toAssessmentDto(next as AssessmentContext);
      await this.d.ledger.append(
        {
          actor,
          action: `assessment.${b.status}`,
          subject: { type: 'assessment', id: String(cur._id) },
          beforeHash: contentHash(toAssessmentDto(cur)),
          afterHash: contentHash(dto),
        },
        s,
      );
      return { created: false, dto };
    }).then(async (r) => ({ created: r.created, dto: { ...r.dto, ...(await this.versionField(r.dto.checklistVersionId)) } }));
  }

  private async versionField(checklistVersionId: string) {
    const v = await this.checklistVersionOf(oid(checklistVersionId));
    return v ? { checklistVersion: v } : {};
  }

  /** Visibility: inside the actor's scope; held external results only for their assessor and above-hospital roles. */
  async visibleFilter(actor: { userId: string } & ActorScope): Promise<Record<string, unknown>> {
    const vis = await visibleFacilityIds(actor);
    const filter: Record<string, unknown> = {};
    if (!('all' in vis)) {
      filter.facilityId = { $in: [...vis.facilityIds].filter(isOid).map(oid) };
      if (vis.wardIds) filter.wardId = { $in: [...vis.wardIds].filter(isOid).map(oid) };
    }
    if (HOSPITAL_ROLES.has(actor.role)) filter.$or = [{ releaseState: { $ne: 'held' } }, { assessorUserId: actor.userId }];
    return filter;
  }

  async findVisible(id: string, actor: { userId: string } & ActorScope): Promise<AssessmentContext> {
    if (!isOid(id)) throw Problem.notFound();
    const doc = await AssessmentContextModel.findOne({ _id: oid(id), ...(await this.visibleFilter(actor)) }).lean<AssessmentContext>();
    // The assessor always sees their own assessment (an external auditor's facility list may change).
    const own = doc ?? (await AssessmentContextModel.findOne({ _id: oid(id), assessorUserId: actor.userId }).lean<AssessmentContext>());
    if (!own) throw Problem.notFound();
    return own;
  }

  async get(id: string, actor: { userId: string } & ActorScope): Promise<AssessmentDto> {
    return this.dto(await this.findVisible(id, actor));
  }

  async list(actor: { userId: string } & ActorScope, q: ListQuery): Promise<Page<AssessmentDto>> {
    const filter: Record<string, unknown> = q.view === 'assigned' ? { assessorUserId: actor.userId } : await this.visibleFilter(actor);
    if (q.wardId) filter.wardId = oid(q.wardId);
    if (q.cycleId) filter.cycleId = oid(q.cycleId);
    if (q.status) filter.status = q.status;
    if (q.releaseState) {
      if (filter.$or) filter.$and = [{ releaseState: q.releaseState }];
      else filter.releaseState = q.releaseState;
    }
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $lt: after };
    const docs = await AssessmentContextModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<AssessmentContext[]>();
    const page = docs.slice(0, q.limit);
    const versions = new Map(
      (await ChecklistVersionModel.find({ _id: { $in: page.map((d) => d.checklistVersionId) } }, { version: 1 }).lean<{ _id: Types.ObjectId; version: number }[]>()).map((c) => [String(c._id), c.version]),
    );
    return {
      items: page.map((d) => toAssessmentDto(d, versions.get(String(d.checklistVersionId)))),
      nextCursor: docs.length > q.limit ? encodeCursor(page[page.length - 1]!._id) : null,
    };
  }

  async formBundle(id: string, actor: { userId: string } & ActorScope) {
    const a = await this.findVisible(id, actor);
    const [ward, checklist] = await Promise.all([
      WardModel.findById(a.wardId).lean<Ward>(),
      ChecklistVersionModel.findById(a.checklistVersionId).lean<ChecklistVersion>(),
    ]);
    if (!ward || !checklist) throw Problem.notFound();
    return buildFormBundle({
      assessment: { id: String(a._id), v: a.v, wardId: String(a.wardId), cycleId: String(a.cycleId) },
      wardType: ward.wardType,
      checklist: {
        ...checklist,
        sections: checklist.sections as BundleSection[],
        questions: checklist.questions as BundleQuestion[],
      },
      issuedAt: this.now(),
    });
  }

  /** `setAssessmentBaseline`: the officer re-points the comparison link, with a reason (ledgered). */
  async setBaseline(id: string, body: { baselineOfId: string; reason: string }, ifMatch: number | undefined, actor: { userId: string } & ActorScope) {
    const a = await this.findVisible(id, actor);
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required');
    const current = await this.dto(a);
    if (ifMatch !== a.v) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this assessment since you opened it', { currentVersion: a.v, current });
    const target = isOid(body.baselineOfId) ? await AssessmentContextModel.findById(body.baselineOfId).lean<AssessmentContext>() : null;
    const errors: { path: string; message: string }[] = [];
    if (!target) errors.push({ path: 'baselineOfId', message: 'unknown assessment' });
    else {
      if (String(target._id) === String(a._id)) errors.push({ path: 'baselineOfId', message: 'cannot be the assessment itself' });
      if (String(target.wardId) !== String(a.wardId)) errors.push({ path: 'baselineOfId', message: 'must be an assessment of the same ward' });
      if (target.status !== 'completed') errors.push({ path: 'baselineOfId', message: 'must be a completed assessment' });
    }
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'This assessment cannot be the baseline', { errors });
    return withTx(async (s) => {
      const next = await AssessmentContextModel.findOneAndUpdate(
        { _id: a._id, v: a.v },
        { $set: { baselineOfId: target!._id }, $inc: { v: 1 } },
        { new: true, session: s, lean: true },
      );
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this assessment since you opened it', { currentVersion: a.v, current });
      const dto = toAssessmentDto(next as AssessmentContext, current.checklistVersion);
      await this.d.ledger.append(
        {
          actor: { userId: actor.userId, role: actor.role },
          action: 'assessment.baseline_changed',
          subject: { type: 'assessment', id: String(a._id) },
          reason: body.reason,
          beforeHash: contentHash(current),
          afterHash: contentHash(dto),
        },
        s,
      );
      return dto;
    });
  }
}
