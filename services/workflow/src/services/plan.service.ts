import { Types, type ClientSession } from 'mongoose';
import { Problem, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  AssessmentContextModel, ChecklistVersionModel, CycleModel, PlanModel, PlanRevisionModel, RiskDefaultModel, ScopeAssignmentModel,
  TaskModel, WardModel,
  type AssessmentContext, type ChecklistVersion, type Cycle, type DraftTaskDoc, type Plan, type PlanRevision, type RiskDefault, type Task, type Ward,
} from '../domain/models/index.js';
import {
  applyDraftUpdate, assertApprovable, decideDraft, diffProjectTasks, humanizeKey, nextRevision, planRevisionChanges,
  type CatalogueQuestionLike, type DraftDecision, type DraftTask, type RevisionChange,
} from '../domain/plan.js';
import type { RiskLevel } from '../domain/catalogue.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import { visibleFacilityIds, type ActorScope } from './admin.service.js';
import type { Outbox } from './outbox.publisher.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';
import type { PlanElevatePort } from './plan-elevate.gateway.js';

export type PlanActor = { userId: string } & ActorScope;

const SYSTEM: LedgerActor = { userId: 'system', role: 'SYSTEM' };
const DAY_MS = 86_400_000;
const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);

// ------------------------------------------------------------------------------------------- DTOs

export function toTaskDto(t: Task, wardId: string, programmeNow: Date) {
  return {
    id: String(t._id), v: t.v, createdAt: iso(t.createdAt)!, updatedAt: iso(t.updatedAt)!,
    planId: String(t.planId), wardId, taskKey: t.taskKey,
    title: { en: t.title.en!, ...(t.title.hi ? { hi: t.title.hi } : {}), ...(t.title.kn ? { kn: t.title.kn } : {}) },
    ...(t.sourceQuestionKey ? { sourceQuestionKey: t.sourceQuestionKey } : {}),
    riskLevel: t.riskLevel, ownerUserId: t.ownerUserId, dueAt: iso(t.dueAt)!,
    overdue: t.state !== 'CLOSED' && new Date(t.dueAt).getTime() < programmeNow.getTime(),
    dependsOnTaskIds: (t.dependsOnTaskIds ?? []).map(String),
    evidenceRule: { photoRequired: t.evidenceRule.photoRequired, minPhotos: t.evidenceRule.minPhotos },
    secondValidation: t.secondValidation, state: t.state, rejectionCount: t.rejectionCount ?? 0,
    blocked: t.blocked ? { reason: t.blocked.reason, by: t.blocked.by, at: iso(t.blocked.at)! } : null,
    ...(t.supportRequestId ? { supportRequestId: String(t.supportRequestId) } : {}),
    ...(t.carriedOverFromTaskId ? { carriedOverFromTaskId: String(t.carriedOverFromTaskId) } : {}),
    ...(t.reopenedFromTaskId ? { reopenedFromTaskId: String(t.reopenedFromTaskId) } : {}),
    ...(t.elevateTaskId ? { elevateTaskId: t.elevateTaskId } : {}),
    currentEvidenceIds: (t.currentEvidenceIds ?? []).map(String),
    syncState: t.syncState,
  };
}

function draftTaskDto(t: DraftTaskDoc) {
  return {
    taskKey: t.taskKey,
    title: { en: t.title.en!, ...(t.title.hi ? { hi: t.title.hi } : {}), ...(t.title.kn ? { kn: t.title.kn } : {}) },
    ...(t.sourceQuestionKey ? { sourceQuestionKey: t.sourceQuestionKey } : {}),
    riskLevel: t.riskLevel, ...(t.ownerUserId ? { ownerUserId: t.ownerUserId } : {}), dueAt: iso(t.dueAt)!,
    dependsOnTaskKeys: [...(t.dependsOnTaskKeys ?? [])],
    evidenceRule: { photoRequired: t.evidenceRule.photoRequired, minPhotos: t.evidenceRule.minPhotos },
    secondValidation: t.secondValidation, included: t.included,
  };
}

export function toPlanDto(p: Plan, facilityId: string, taskCounts?: Record<string, number>) {
  return {
    id: String(p._id), v: p.v, createdAt: iso(p.createdAt)!, updatedAt: iso(p.updatedAt)!,
    wardId: String(p.wardId), facilityId, cycleId: String(p.cycleId), sourceAssessmentId: String(p.sourceAssessmentId),
    status: p.status, ...(p.elevateProjectId && p.status !== 'draft' ? { elevateProjectId: p.elevateProjectId } : {}),
    planTemplateVersion: p.planTemplateVersion ?? 1, revision: p.revision ?? 0,
    goals: (p.goals ?? []).map((g) => ({ key: g.key, text: g.text })),
    milestones: (p.milestones ?? []).map((m) => ({ key: m.key, text: m.text, dueAt: iso(m.dueAt ?? p.createdAt)! })),
    carriedOverTaskIds: (p.carriedOverTaskIds ?? []).map(String),
    ...(p.approvedBy ? { approvedBy: p.approvedBy } : {}), ...(p.approvedAt ? { approvedAt: iso(p.approvedAt) } : {}),
    draftCreatedAt: iso(p.createdAt)!,
    ...(taskCounts ? { taskCounts } : {}),
  };
}

export function toRevisionDto(r: PlanRevision) {
  return {
    id: String(r._id), v: r.v, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
    planId: String(r.planId), revision: r.revision, actorUserId: r.actorUserId, role: r.role, reason: r.reason, source: r.source,
    changes: r.changes.map((c) => ({
      op: c.op, taskId: String(c.taskId),
      ...(c.before && typeof c.before === 'object' ? { before: c.before as object } : {}),
      ...(c.after && typeof c.after === 'object' ? { after: c.after as object } : {}),
    })),
  };
}

// ------------------------------------------------------------------------------------------ inputs

export interface DraftPlanUpdate {
  goals?: { key: string; text: string }[];
  milestones?: { key: string; text: string; dueAt: string }[];
  tasks?: { taskKey: string; ownerUserId?: string; dueAt?: string; dependsOnTaskKeys?: string[]; included?: boolean }[];
}

export interface PlanChangeInput {
  op: 'add' | 'remove' | 'update';
  taskId?: string;
  task?: { title: { en: string; hi?: string; kn?: string }; sourceQuestionKey?: string; riskLevel: RiskLevel; ownerUserId: string; dueAt?: string; dependsOnTaskIds?: string[] };
  set?: { title?: { en: string; hi?: string; kn?: string }; dueAt?: string; dependsOnTaskIds?: string[] };
}

export interface CompletionInput {
  assessment: AssessmentContext;
  ward: Ward;
  cycle: Cycle;
  checklist: ChecklistVersion;
  failedQuestionKeys: string[];
  firstInCycle: boolean;
}

/**
 * A revision made on behalf of another workflow (US6: mentor-agreed actions, FR-023): tasks carry
 * `supportRequestId`, the revision and its event carry the source, and `inTx` runs inside the
 * revision's transaction with the created task ids (in the order of the add changes).
 */
export interface RevisionLink {
  source: 'mentor_outcome';
  supportRequestId: string;
  inTx?: (s: ClientSession, r: { revision: number; taskIds: string[] }) => Promise<void>;
}

/** Reconciliation trigger after each transition (FR-019); the job itself runs out of band. */
export interface ReconcileTrigger { trigger(planId: string): void }

/**
 * Improvement plans (US3; FR-011, FR-012, FR-017, FR-018, FR-018a). Every state change, its ledger
 * record and its outbox events commit in one transaction; ELEVATE (project-service, written only
 * here, as the ward's service account) is called before that transaction, so an ELEVATE failure
 * leaves the programme plan unchanged (503 ELEVATE_UNAVAILABLE).
 */
export class PlanService {
  private reconcile: ReconcileTrigger | undefined;

  constructor(private readonly d: {
    ledger: LedgerService;
    outbox: Outbox;
    elevate: PlanElevatePort;
    programmeNow: () => Date;
    logger?: Logger;
  }) {}

  attachReconcile(r: ReconcileTrigger): void {
    this.reconcile = r;
  }

  // ----------------------------------------------------------------------------- draft from completion

  /** Drafts (or not) the plan for a completed assessment, inside the consumer's transaction. */
  async draftFromCompletion(i: CompletionInput, session: ClientSession): Promise<DraftDecision & { planId?: string }> {
    const riskDefaults = await RiskDefaultModel.find({}).session(session).lean<RiskDefault[]>();
    const previous = await this.previousActivePlan(i.ward._id, i.cycle._id, session);
    const previousTasks = previous
      ? (await TaskModel.find({ planId: previous._id }, { state: 1 }).session(session).lean<Task[]>()).map((t) => ({ id: String(t._id), state: t.state }))
      : [];
    const decision = decideDraft({
      questions: i.checklist.questions as CatalogueQuestionLike[],
      failedQuestionKeys: i.failedQuestionKeys,
      firstInCycle: i.firstInCycle,
      riskDefaults,
      templateTasks: (i.checklist.planTemplate?.tasks ?? []).map((t) => ({ templateTaskKey: t.templateTaskKey, title: { en: t.title.en ?? humanizeKey(t.templateTaskKey), ...t.title } })),
      now: this.d.programmeNow(),
      previousPlanTasks: previousTasks,
    });
    const subject = { type: 'assessment' as const, id: String(i.assessment._id) };
    if (decision.outcome !== 'draft_plan_created') {
      const reason = decision.outcome === 'no_actions_needed' ? 'No failed questions: no actions needed, no plan' : 'Later assessment in the same cycle: no new plan';
      await this.d.ledger.append({ actor: SYSTEM, action: 'plan.not_created', subject, reason }, session);
      return decision;
    }
    const [plan] = await PlanModel.create([{
      wardId: i.ward._id, cycleId: i.cycle._id, sourceAssessmentId: i.assessment._id, status: 'draft',
      planTemplateVersion: i.checklist.planTemplate?.version ?? 1, revision: 0, goals: [], milestones: [],
      carriedOverTaskIds: decision.carriedOverTaskIds.map(oid), draftTasks: decision.draftTasks, v: 0,
    }], { session });
    const doc = plan!.toObject() as Plan;
    await this.d.ledger.append({
      actor: SYSTEM, action: 'plan.drafted', subject: { type: 'plan', id: String(doc._id) },
      reason: `Draft from assessment ${String(i.assessment._id)}: ${decision.draftTasks.length} task(s), ${decision.carriedOverTaskIds.length} carried over`,
      afterHash: contentHash(toPlanDto(doc, String(i.ward.facilityId))),
    }, session);
    return { ...decision, planId: String(doc._id) };
  }

  private previousActivePlan(wardId: Types.ObjectId, cycleId: Types.ObjectId, session?: ClientSession) {
    return PlanModel.findOne({ wardId, cycleId: { $ne: cycleId }, status: 'active' }).sort({ createdAt: -1 }).session(session ?? null).lean<Plan>();
  }

  // --------------------------------------------------------------------------------------- scope

  private async scopeFilter(actor: PlanActor): Promise<{ wardIds?: Types.ObjectId[] }> {
    const v = await visibleFacilityIds(actor);
    if ('all' in v) return {};
    const wards = await WardModel.find({ facilityId: { $in: [...v.facilityIds].map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    const ids = new Set(wards.map((w) => String(w._id)));
    v.wardIds?.forEach((w) => ids.add(w));
    return { wardIds: [...ids].map(oid) };
  }

  /** Unknown and out-of-scope plans answer alike (existence is not disclosed). */
  private async visiblePlan(id: string, actor: PlanActor): Promise<{ plan: Plan; ward: Ward }> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    const plan = await PlanModel.findById(id).lean<Plan>();
    const ward = plan ? await WardModel.findById(plan.wardId).lean<Ward>() : null;
    if (!plan || !ward) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    const f = await this.scopeFilter(actor);
    if (f.wardIds && !f.wardIds.some((w) => String(w) === String(ward._id))) throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    return { plan, ward };
  }

  // ----------------------------------------------------------------------------------------- reads

  async list(actor: PlanActor, q: { status?: Plan['status']; wardId?: string; facilityId?: string; cycleId?: string; cursor?: string; limit: number }): Promise<Page<ReturnType<typeof toPlanDto>>> {
    const f = await this.scopeFilter(actor);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.cycleId) filter.cycleId = oid(q.cycleId);
    let wardIds = f.wardIds;
    if (q.facilityId) {
      const ws = (await WardModel.find({ facilityId: oid(q.facilityId) }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).map((w) => w._id);
      wardIds = wardIds ? wardIds.filter((w) => ws.some((x) => String(x) === String(w))) : ws;
    }
    if (q.wardId) wardIds = (wardIds ?? [oid(q.wardId)]).filter((w) => String(w) === q.wardId);
    if (wardIds) filter.wardId = { $in: wardIds };
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $lt: after };
    const docs = await PlanModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<Plan[]>();
    const page = docs.slice(0, q.limit);
    const wards = new Map((await WardModel.find({ _id: { $in: page.map((p) => p.wardId) } }, { facilityId: 1 }).lean<Ward[]>()).map((w) => [String(w._id), String(w.facilityId)]));
    const counts = await this.taskCounts(page.map((p) => p._id));
    return {
      items: page.map((p) => toPlanDto(p, wards.get(String(p.wardId)) ?? '', counts.get(String(p._id)) ?? this.draftCounts(p))),
      nextCursor: docs.length > q.limit ? encodeCursor(page.at(-1)!._id) : null,
    };
  }

  private draftCounts(p: Plan): Record<string, number> {
    const out: Record<string, number> = { critical: 0, high: 0, normal: 0 };
    for (const t of p.draftTasks ?? []) if (t.included) out[t.riskLevel] = (out[t.riskLevel] ?? 0) + 1;
    return out;
  }

  private async taskCounts(planIds: Types.ObjectId[]): Promise<Map<string, Record<string, number>>> {
    const rows = await TaskModel.aggregate<{ _id: { planId: Types.ObjectId; risk: string }; n: number }>([
      { $match: { planId: { $in: planIds } } },
      { $group: { _id: { planId: '$planId', risk: '$riskLevel' }, n: { $sum: 1 } } },
    ]);
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const m = out.get(String(r._id.planId)) ?? { critical: 0, high: 0, normal: 0 };
      m[r._id.risk] = r.n;
      out.set(String(r._id.planId), m);
    }
    return out;
  }

  private async detail(plan: Plan, ward: Ward) {
    const facilityId = String(ward.facilityId);
    const now = this.d.programmeNow();
    const own = plan.status === 'draft' ? [] : await TaskModel.find({ planId: plan._id }).sort({ _id: 1 }).lean<Task[]>();
    const carried = (plan.carriedOverTaskIds ?? []).length
      ? await TaskModel.find({ _id: { $in: plan.carriedOverTaskIds } }).lean<Task[]>()
      : [];
    const others = await AssessmentContextModel.find({
      wardId: plan.wardId, cycleId: plan.cycleId, status: 'completed', _id: { $ne: plan.sourceAssessmentId },
    }, { failedQuestionKeys: 1 }).lean<AssessmentContext[]>();
    const planned = new Set([...(plan.draftTasks ?? []).map((t) => t.sourceQuestionKey), ...own.map((t) => t.sourceQuestionKey)].filter(Boolean));
    const checklist = await this.checklistOf(plan.sourceAssessmentId);
    const risk = new Map((checklist?.questions ?? []).map((q) => [q.questionKey, q.riskLevel]));
    const unplannedFindings = others.flatMap((a) => (a.failedQuestionKeys ?? [])
      .filter((k) => !planned.has(k))
      .map((k) => ({ assessmentId: String(a._id), questionKey: k, riskLevel: risk.get(k) ?? 'normal' })));
    const counts = plan.status === 'draft' ? this.draftCounts(plan) : (await this.taskCounts([plan._id])).get(String(plan._id)) ?? { critical: 0, high: 0, normal: 0 };
    return {
      ...toPlanDto(plan, facilityId, counts),
      ...(plan.status === 'draft' ? { draftTasks: (plan.draftTasks ?? []).map(draftTaskDto) } : {}),
      tasks: [...own, ...carried].map((t) => toTaskDto(t, String(plan.wardId), now)),
      unplannedFindings,
    };
  }

  private async checklistOf(assessmentId: Types.ObjectId): Promise<ChecklistVersion | null> {
    const a = await AssessmentContextModel.findById(assessmentId, { checklistVersionId: 1 }).lean<AssessmentContext>();
    return a ? ChecklistVersionModel.findById(a.checklistVersionId).lean<ChecklistVersion>() : null;
  }

  async get(id: string, actor: PlanActor) {
    const { plan, ward } = await this.visiblePlan(id, actor);
    return this.detail(plan, ward);
  }

  async revisions(id: string, actor: PlanActor, q: { cursor?: string; limit: number }): Promise<Page<ReturnType<typeof toRevisionDto>>> {
    const { plan } = await this.visiblePlan(id, actor);
    const after = decodeCursor(q.cursor);
    const docs = await PlanRevisionModel.find({ planId: plan._id, ...(after ? { _id: { $lt: after } } : {}) })
      .sort({ _id: -1 }).limit(q.limit + 1).lean<PlanRevision[]>();
    const page = docs.slice(0, q.limit);
    return { items: page.map(toRevisionDto), nextCursor: docs.length > q.limit ? encodeCursor(page.at(-1)!._id) : null };
  }

  // ---------------------------------------------------------------------------------------- writes

  private assertVersion(plan: Plan, ifMatch: number | undefined, current: unknown): void {
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required');
    if (ifMatch !== plan.v) {
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this plan since you opened it', { currentVersion: plan.v, current });
    }
  }

  /** An owner must hold a current assignment that covers the plan's ward (FR-028). */
  private async assertOwners(userIds: string[], ward: Ward): Promise<void> {
    const now = new Date();
    const bad: { path: string; message: string }[] = [];
    for (const u of [...new Set(userIds)]) {
      const ok = await ScopeAssignmentModel.exists({
        userId: u,
        role: { $in: ['FRONTLINE', 'WARD_SUPERVISOR', 'IPC_OFFICER'] },
        validFrom: { $lte: now },
        $and: [
          { $or: [{ validTo: null }, { validTo: { $gt: now } }] },
          { $or: [{ 'scope.wardIds': String(ward._id) }, { 'scope.level': 'facility', 'scope.facilityId': String(ward.facilityId) }] },
        ],
      });
      if (!ok) bad.push({ path: 'ownerUserId', message: `${u} does not work in this ward` });
    }
    if (bad.length) throw Problem.unprocessable('VALIDATION_FAILED', bad.map((b) => b.message).join('; '), { errors: bad });
  }

  async updateDraft(id: string, body: DraftPlanUpdate, ifMatch: number | undefined, actor: PlanActor) {
    const { plan, ward } = await this.visiblePlan(id, actor);
    if (plan.status !== 'draft') throw Problem.conflict('INVALID_TRANSITION', 'Only a draft can be edited; change an approved plan with a revision');
    this.assertVersion(plan, ifMatch, await this.detail(plan, ward));
    const tasks = applyDraftUpdate((plan.draftTasks ?? []) as DraftTask[], (body.tasks ?? []).map((t) => ({
      taskKey: t.taskKey, ownerUserId: t.ownerUserId, dependsOnTaskKeys: t.dependsOnTaskKeys, included: t.included,
      ...(t.dueAt ? { dueAt: new Date(t.dueAt) } : {}),
    })));
    await this.assertOwners((body.tasks ?? []).flatMap((t) => (t.ownerUserId ? [t.ownerUserId] : [])), ward);
    const set: Record<string, unknown> = { draftTasks: tasks };
    if (body.goals) set.goals = body.goals;
    if (body.milestones) set.milestones = body.milestones.map((m) => ({ key: m.key, text: m.text, dueAt: new Date(m.dueAt) }));
    const before = toPlanDto(plan, String(ward.facilityId), this.draftCounts(plan));
    await withTx(async (s) => {
      const next = await PlanModel.findOneAndUpdate({ _id: plan._id, v: plan.v, status: 'draft' }, { $set: set, $inc: { v: 1 } }, { new: true, session: s, lean: true });
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this plan since you opened it');
      await this.d.ledger.append({
        actor: { userId: actor.userId, role: actor.role }, action: 'plan.updated', subject: { type: 'plan', id: String(plan._id) },
        beforeHash: contentHash({ ...before, draftTasks: (plan.draftTasks ?? []).map(draftTaskDto) }),
        afterHash: contentHash({ ...toPlanDto(next as Plan, String(ward.facilityId)), draftTasks: ((next as Plan).draftTasks ?? []).map(draftTaskDto) }),
      }, s);
    });
    return this.get(id, actor);
  }

  /**
   * Approval (FR-012, FR-018a): ELEVATE first (import the cycle's template as the ward service
   * account, then sync the task set), then one transaction: tasks + plan active + revision 1 +
   * ledger + `ipc.plan.created` and `ipc.task.assigned` per task.
   */
  async approve(id: string, ifMatch: number | undefined, actor: PlanActor) {
    const { plan, ward } = await this.visiblePlan(id, actor);
    if (plan.status !== 'draft') throw Problem.conflict('INVALID_TRANSITION', 'This plan is already approved');
    this.assertVersion(plan, ifMatch, await this.detail(plan, ward));
    const draft = (plan.draftTasks ?? []) as DraftTask[];
    assertApprovable(draft);
    const included = draft.filter((t) => t.included);
    await this.assertOwners(included.map((t) => t.ownerUserId!), ward);
    if (!ward.serviceAccountUserId) throw Problem.unprocessable('VALIDATION_FAILED', 'This ward has no programme service account (FR-018a)');
    const cycle = await CycleModel.findById(plan.cycleId).lean<Cycle>();
    if (!cycle) throw Problem.unprocessable('VALIDATION_FAILED', 'The plan cycle no longer exists');

    // ---- ELEVATE (outside the transaction; nothing programme-side changes if it fails)
    const svc = ward.serviceAccountUserId;
    const templateId = await this.d.elevate.templateIdForCycle(cycle);
    const project = await this.d.elevate.ensureWardPlan(svc, templateId, plan.elevateProjectId);
    if (project.projectId !== plan.elevateProjectId) {
      // Recovery marker only (no version bump): a retried approval re-uses this ELEVATE plan.
      await PlanModel.updateOne({ _id: plan._id, status: 'draft' }, { $set: { elevateProjectId: project.projectId } });
    }
    const ids = new Map(included.map((t) => [t.taskKey, new Types.ObjectId()]));
    const diff = diffProjectTasks(included.map((t) => ({ id: String(ids.get(t.taskKey)), taskKey: t.taskKey, title: t.title.en, state: 'ASSIGNED' as const })), project.tasks);
    await this.d.elevate.syncTasks(svc, project.projectId, diff.sync);

    // ---- programme (one transaction)
    const now = new Date();
    const approver: LedgerActor = { userId: actor.userId, role: actor.role };
    const facilityId = String(ward.facilityId);
    await withTx(async (s) => {
      const taskDocs = included.map((t) => ({
        _id: ids.get(t.taskKey)!, planId: plan._id, taskKey: t.taskKey, title: t.title, ...(t.sourceQuestionKey ? { sourceQuestionKey: t.sourceQuestionKey } : {}),
        riskLevel: t.riskLevel, ownerUserId: t.ownerUserId!, dueAt: t.dueAt, dependsOnTaskIds: t.dependsOnTaskKeys.map((k) => ids.get(k)!),
        evidenceRule: t.evidenceRule, secondValidation: t.secondValidation, state: 'ASSIGNED' as const, rejectionCount: 0, blocked: null,
        elevateTaskId: diff.links[String(ids.get(t.taskKey))], currentEvidenceIds: [], syncState: 'in_sync' as const, v: 0,
      }));
      const next = await PlanModel.findOneAndUpdate(
        { _id: plan._id, v: plan.v, status: 'draft' },
        { $set: { status: 'active', revision: 1, approvedBy: actor.userId, approvedAt: now, elevateProjectId: project.projectId }, $unset: { draftTasks: 1 }, $inc: { v: 1 } },
        { new: true, session: s, lean: true },
      );
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this plan since you opened it');
      const created = await TaskModel.create(taskDocs, { session: s, ordered: true });
      await PlanRevisionModel.create([{
        planId: plan._id, revision: 1, actorUserId: actor.userId, role: actor.role, reason: 'Plan approved', source: 'officer',
        changes: created.map((t) => ({ op: 'add', taskId: t._id, after: { taskKey: t.taskKey, ownerUserId: t.ownerUserId, dueAt: t.dueAt.toISOString(), riskLevel: t.riskLevel } })),
        v: 0,
      }], { session: s });
      const planDto = toPlanDto(next as Plan, facilityId);
      await this.d.ledger.append({
        actor: approver, action: 'plan.approved', subject: { type: 'plan', id: String(plan._id) },
        reason: `Approved with ${created.length} task(s); ELEVATE plan ${project.projectId}`, afterHash: contentHash(planDto),
      }, s);
      const byRisk = { critical: 0, high: 0, normal: 0 };
      for (const t of created) byRisk[t.riskLevel] += 1;
      await this.d.outbox.enqueue({
        type: 'ipc.plan.created', key: String(plan.wardId), actor: approver, subject: { type: 'plan', id: String(plan._id) },
        payload: {
          planId: String(plan._id), wardId: String(plan.wardId), facilityId, cycleId: String(plan.cycleId), sourceAssessmentId: String(plan.sourceAssessmentId),
          revision: 1, planTemplateVersion: plan.planTemplateVersion ?? 1, elevateProjectId: project.projectId, taskCount: created.length,
          taskCountsByRisk: byRisk, carriedOverTaskIds: (plan.carriedOverTaskIds ?? []).map(String), approvedBy: actor.userId, approvedAt: now.toISOString(),
        },
      }, s);
      for (const t of created) await this.taskAssigned(t.toObject() as Task, plan, facilityId, approver, 'initial', s);
    });
    this.reconcile?.trigger(id);
    return this.get(id, actor);
  }

  private async taskAssigned(t: Task, plan: Plan, facilityId: string, actor: LedgerActor, assignment: 'initial' | 'reassigned' | 'reopened' | 'carried_over', s: ClientSession) {
    await this.d.ledger.append({
      actor, action: 'task.assigned', subject: { type: 'task', id: String(t._id) },
      reason: `${assignment}: owner ${t.ownerUserId}, due ${t.dueAt.toISOString()}`, afterHash: contentHash(toTaskDto(t, String(plan.wardId), this.d.programmeNow())),
    }, s);
    await this.d.outbox.enqueue({
      type: 'ipc.task.assigned', key: String(plan.wardId), actor, subject: { type: 'task', id: String(t._id) },
      payload: {
        taskId: String(t._id), planId: String(plan._id), wardId: String(plan.wardId), facilityId, riskLevel: t.riskLevel, assignment,
        ownerUserId: t.ownerUserId, previousOwnerUserId: null, state: t.state, dueAt: t.dueAt.toISOString(), secondValidation: t.secondValidation,
      },
    }, s);
  }

  /** A revision of an active plan (FR-017): add, remove or change tasks with a reason. Closed tasks never change (FR-015). */
  async revise(id: string, body: { reason: string; changes: PlanChangeInput[] }, ifMatch: number | undefined, actor: PlanActor, link?: RevisionLink) {
    const { plan, ward } = await this.visiblePlan(id, actor);
    if (plan.status !== 'active') throw Problem.conflict('INVALID_TRANSITION', 'Only an active plan can be revised');
    this.assertVersion(plan, ifMatch, await this.detail(plan, ward));
    const tasks = await TaskModel.find({ $or: [{ planId: plan._id }, { _id: { $in: plan.carriedOverTaskIds ?? [] } }] }).lean<Task[]>();
    const byId = new Map(tasks.map((t) => [String(t._id), t]));
    const riskDefaults = new Map((await RiskDefaultModel.find({}).lean<RiskDefault[]>()).map((r) => [r.riskLevel, r]));
    const checklist = await this.checklistOf(plan.sourceAssessmentId);
    const questions = new Map((checklist?.questions ?? []).map((q) => [q.questionKey, q]));
    const now = this.d.programmeNow();

    const inPlan = (taskId: string | undefined, i: number): Task => {
      const t = taskId ? byId.get(taskId) : undefined;
      if (!t) throw Problem.unprocessable('VALIDATION_FAILED', `Change ${i + 1}: the task is not part of this plan`, { errors: [{ path: `changes[${i}].taskId`, message: 'not in this plan' }] });
      if (t.state === 'CLOSED') throw Problem.conflict('INVALID_TRANSITION', 'A closed task cannot be changed; reopen it instead');
      return t;
    };
    const deps = (list: string[] | undefined, i: number) => (list ?? []).map((d) => {
      if (!byId.has(d)) throw Problem.unprocessable('VALIDATION_FAILED', `Change ${i + 1}: dependency ${d} is not in this plan`);
      return oid(d);
    });

    const adds: Record<string, unknown>[] = [];
    const removes: Task[] = [];
    const updates: { t: Task; set: Record<string, unknown> }[] = [];
    const changes: RevisionChange[] = [];
    const owners: string[] = [];
    body.changes.forEach((c, i) => {
      if (c.op === 'add') {
        if (!c.task) throw Problem.unprocessable('VALIDATION_FAILED', `Change ${i + 1}: add needs a task`);
        const d = riskDefaults.get(c.task.riskLevel);
        if (!d) throw Problem.unprocessable('VALIDATION_FAILED', `No risk default for ${c.task.riskLevel}`);
        const q = c.task.sourceQuestionKey ? questions.get(c.task.sourceQuestionKey) : undefined;
        const _id = new Types.ObjectId();
        const doc = {
          _id, planId: plan._id, taskKey: (q?.templateTaskKey ?? `added-${String(_id).slice(-8)}`).slice(0, 40), title: c.task.title,
          ...(c.task.sourceQuestionKey ? { sourceQuestionKey: c.task.sourceQuestionKey } : {}), riskLevel: c.task.riskLevel, ownerUserId: c.task.ownerUserId,
          dueAt: c.task.dueAt ? new Date(c.task.dueAt) : new Date(now.getTime() + d.dueDays * DAY_MS), dependsOnTaskIds: deps(c.task.dependsOnTaskIds, i),
          evidenceRule: d.evidenceRule, secondValidation: d.secondValidation, state: 'ASSIGNED', rejectionCount: 0, blocked: null,
          currentEvidenceIds: [], syncState: 'pending', v: 0, ...(link ? { supportRequestId: oid(link.supportRequestId) } : {}),
        };
        owners.push(c.task.ownerUserId);
        adds.push(doc);
        changes.push({ op: 'add', taskId: String(_id), after: { title: c.task.title, riskLevel: c.task.riskLevel, ownerUserId: c.task.ownerUserId, dueAt: doc.dueAt.toISOString() } });
      } else if (c.op === 'remove') {
        const t = inPlan(c.taskId, i);
        removes.push(t);
        changes.push({ op: 'remove', taskId: String(t._id), before: { title: t.title, state: t.state, ownerUserId: t.ownerUserId } });
      } else {
        const t = inPlan(c.taskId, i);
        if (!c.set || Object.keys(c.set).length === 0) throw Problem.unprocessable('VALIDATION_FAILED', `Change ${i + 1}: update needs fields to set`);
        const set: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (c.set.title) { set.title = c.set.title; before.title = t.title; after.title = c.set.title; }
        if (c.set.dueAt) { set.dueAt = new Date(c.set.dueAt); before.dueAt = t.dueAt.toISOString(); after.dueAt = c.set.dueAt; }
        if (c.set.dependsOnTaskIds) {
          if (c.set.dependsOnTaskIds.includes(String(t._id))) throw Problem.unprocessable('VALIDATION_FAILED', 'A task cannot depend on itself');
          set.dependsOnTaskIds = deps(c.set.dependsOnTaskIds, i);
          before.dependsOnTaskIds = (t.dependsOnTaskIds ?? []).map(String); after.dependsOnTaskIds = c.set.dependsOnTaskIds;
        }
        updates.push({ t, set });
        changes.push({ op: 'update', taskId: String(t._id), before, after });
      }
    });
    await this.assertOwners(owners, ward);
    const revision = nextRevision(plan.revision ?? 0);
    const recorded = planRevisionChanges(changes);
    const who: LedgerActor = { userId: actor.userId, role: actor.role };
    const facilityId = String(ward.facilityId);
    await withTx(async (s) => {
      const removedCarried = removes.filter((t) => String(t.planId) !== String(plan._id)).map((t) => t._id);
      const next = await PlanModel.findOneAndUpdate(
        { _id: plan._id, v: plan.v, status: 'active' },
        { $set: { revision }, $inc: { v: 1 }, ...(removedCarried.length ? { $pull: { carriedOverTaskIds: { $in: removedCarried } } } : {}) },
        { new: true, session: s, lean: true },
      );
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this plan since you opened it');
      const created = adds.length ? await TaskModel.create(adds, { session: s, ordered: true }) : [];
      for (const t of removes) {
        // A carried-over task belongs to the previous plan: the revision only unlinks it.
        if (String(t.planId) === String(plan._id)) await TaskModel.deleteOne({ _id: t._id, state: { $ne: 'CLOSED' } }, { session: s });
        await this.d.ledger.append({ actor: who, action: 'task.removed', subject: { type: 'task', id: String(t._id) }, reason: body.reason, beforeHash: contentHash(toTaskDto(t, String(plan.wardId), now)) }, s);
      }
      for (const u of updates) {
        const after = await TaskModel.findOneAndUpdate({ _id: u.t._id, v: u.t.v, state: { $ne: 'CLOSED' } }, { $set: { ...u.set, syncState: 'pending' }, $inc: { v: 1 } }, { new: true, session: s, lean: true });
        if (!after) throw Problem.conflict('VERSION_CONFLICT', 'A task changed meanwhile; reload and try again');
        await this.d.ledger.append({
          actor: who, action: 'task.changed', subject: { type: 'task', id: String(u.t._id) }, reason: body.reason,
          beforeHash: contentHash(toTaskDto(u.t, String(plan.wardId), now)), afterHash: contentHash(toTaskDto(after as Task, String(plan.wardId), now)),
        }, s);
      }
      await PlanRevisionModel.create([{ planId: plan._id, revision, actorUserId: actor.userId, role: actor.role, reason: body.reason, source: link?.source ?? 'officer', changes: recorded.map((c) => ({ ...c, taskId: oid(c.taskId) })), v: 0 }], { session: s });
      await this.d.ledger.append({
        actor: who, action: 'plan.revised', subject: { type: 'plan', id: String(plan._id) }, reason: `r${revision}: ${body.reason}`.slice(0, 500),
        beforeHash: contentHash(toPlanDto(plan, facilityId)), afterHash: contentHash(toPlanDto(next as Plan, facilityId)),
      }, s);
      await this.d.outbox.enqueue({
        type: 'ipc.plan.revised', key: String(plan.wardId), actor: who, subject: { type: 'plan', id: String(plan._id) },
        payload: {
          planId: String(plan._id), wardId: String(plan.wardId), facilityId, revision, source: link?.source ?? 'officer',
          ...(link ? { supportRequestId: link.supportRequestId } : {}), changes: recorded.map((c) => ({ op: c.op, taskId: c.taskId })),
        },
      }, s);
      for (const t of created) await this.taskAssigned(t.toObject() as Task, plan, facilityId, who, 'initial', s);
      await link?.inTx?.(s, { revision, taskIds: created.map((t) => String(t._id)) });
    });
    this.reconcile?.trigger(id);
    return this.get(id, actor);
  }
}

