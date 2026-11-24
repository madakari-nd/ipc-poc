import { Types, type ClientSession } from 'mongoose';
import { Problem, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  DecisionModel, EscalationModel, FacilityModel, LedgerRecordModel, PlanModel, PlanRevisionModel, RiskDefaultModel, ScopeAssignmentModel, TaskModel, WardModel,
  type Decision, type Escalation, type LedgerRecordDoc, type Plan, type RiskDefault, type Task, type Ward,
} from '../domain/models/index.js';
import type { TaskStateName } from '../domain/plan.js';
import {
  OPEN_STATES, decideTransition, parseTransitionReason, transitionReason,
  type DependencyFact, type EvidenceFact, type TaskCommand, type TransitionOutcome,
} from '../domain/task.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import type { ActorScope } from './admin.service.js';
import type { Outbox } from './outbox.publisher.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';
import { toTaskDto, type ReconcileTrigger } from './plan.service.js';

export type TaskActor = { userId: string } & ActorScope;

export type TaskView = 'mine' | 'ward' | 'review_queue' | 'validation_queue' | 'needs_reassignment' | 'overdue';
export interface TaskListQuery {
  view: TaskView; wardId?: string; planId?: string; state?: TaskStateName; riskLevel?: Task['riskLevel']; blocked?: boolean; cursor?: string; limit: number;
}

/** Edge-attested evidence metadata for a submission (the Edge owns the evidence locker). */
export interface SubmissionInput { evidenceIds: string[]; note?: string; evidence: EvidenceFact[] }

/**
 * Hook run INSIDE the transaction of every return (supervisor or validator), after the task and
 * Decision are written: US5 escalation rule R3 ("repeated rejection") plugs in here so its
 * escalation records commit atomically with the return. The `ipc.task.decided` (kind `return`) and
 * `ipc.task.validated` (kind `validation_return`) events carry the new `rejectionCount` for
 * asynchronous consumers.
 */
export type ReturnHook = (e: {
  task: Task; wardId: string; facilityId: string; kind: 'return' | 'validation_return'; rejectionCount: number;
  decisionId: string; actor: LedgerActor; session: ClientSession;
}) => Promise<void>;

const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);
const DAY_MS = 86_400_000;
const DENIED = () => Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');

export function toDecisionDto(d: Decision) {
  return {
    id: String(d._id), v: d.v, createdAt: iso(d.createdAt)!, updatedAt: iso(d.updatedAt)!, taskId: String(d.taskId), kind: d.kind,
    actorUserId: d.actorUserId, role: d.role, reasonCode: d.reasonCode, ...(d.reasonText ? { reasonText: d.reasonText } : {}),
    evidenceIds: (d.evidenceIds ?? []).map(String), evidenceHashes: [...(d.evidenceHashes ?? [])], at: iso(d.at)!,
  };
}

function toEscalationDto(e: Escalation) {
  return {
    id: String(e._id), v: e.v, createdAt: iso(e.createdAt)!, updatedAt: iso(e.updatedAt)!, taskId: String(e.taskId), ruleCode: e.ruleCode,
    level: e.level, targetRole: e.targetRole, targetUserIds: [...(e.targetUserIds ?? [])], raisedAt: iso(e.raisedAt)!, raisedBy: e.raisedBy,
    ...(e.reason ? { reason: e.reason } : {}), notificationIds: (e.notificationIds ?? []).map(String), vacantTargetFlag: !!e.vacantTargetFlag,
  };
}

/**
 * Task execution and verification (US4; FR-013..FR-016). Each transition is decided by the pure
 * state machine (domain/task.ts) and written in ONE transaction: the task (version + 1), the
 * Decision, the ledger record(s) and the `ipc.task.*` outbox event. State changes then trigger the
 * one-way ELEVATE reconciliation, which marks a CLOSED task completed in project-service (FR-019).
 */
export class TaskService {
  private reconcile: ReconcileTrigger | undefined;
  private readonly returnHooks: ReturnHook[] = [];

  constructor(private readonly d: { ledger: LedgerService; outbox: Outbox; programmeNow: () => Date; logger?: Logger }) {}

  attachReconcile(r: ReconcileTrigger): void {
    this.reconcile = r;
  }

  /** US5: register the on-return escalation hook (see ReturnHook). */
  onReturn(hook: ReturnHook): void {
    this.returnHooks.push(hook);
  }

  // ------------------------------------------------------------------------------------- scope

  /** Wards whose tasks the acting role may see; own tasks are always visible (FR-028). */
  private async visibleWards(actor: TaskActor): Promise<{ all: true } | { wardIds: Set<string> }> {
    const mine = actor.assignments.filter((a) => a.role === actor.role);
    if (mine.some((a) => a.scope.level === 'state')) return { all: true };
    const facilityIds = new Set<string>();
    const wardIds = new Set<string>();
    for (const { scope } of mine) {
      if (scope.level === 'district' && scope.districtCode) {
        (await FacilityModel.find({ districtCode: scope.districtCode }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).forEach((f) => facilityIds.add(String(f._id)));
      } else if (scope.level === 'facility') {
        if (scope.facilityId) facilityIds.add(scope.facilityId);
        scope.facilityIds?.forEach((f) => facilityIds.add(f));
      } else if (scope.level === 'wards') {
        scope.wardIds?.forEach((w) => wardIds.add(w));
      }
    }
    if (actor.role === 'MENTOR') actor.mentorFacilityIds?.forEach((f) => facilityIds.add(f));
    if (facilityIds.size) {
      (await WardModel.find({ facilityId: { $in: [...facilityIds].map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).forEach((w) => wardIds.add(String(w._id)));
    }
    return { wardIds };
  }

  private async scopeFilter(actor: TaskActor, wardId?: string): Promise<Record<string, unknown>> {
    const vis = await this.visibleWards(actor);
    let wards: string[] | undefined = 'all' in vis ? undefined : [...vis.wardIds];
    if (wardId) wards = wards ? wards.filter((w) => w === wardId) : [wardId];
    if (!wards) return {};
    const plans = await PlanModel.find({ wardId: { $in: wards.map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    const byPlan = { planId: { $in: plans.map((p) => p._id) } };
    return wardId ? byPlan : { $or: [byPlan, { ownerUserId: actor.userId }] };
  }

  /** Unknown and out-of-scope tasks answer alike (existence is not disclosed). */
  private async visibleTask(id: string, actor: TaskActor): Promise<{ task: Task; plan: Plan; ward: Ward }> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw DENIED();
    const task = await TaskModel.findById(id).lean<Task>();
    const plan = task ? await PlanModel.findById(task.planId).lean<Plan>() : null;
    const ward = plan ? await WardModel.findById(plan.wardId).lean<Ward>() : null;
    if (!task || !plan || !ward) throw DENIED();
    if (task.ownerUserId !== actor.userId) {
      const vis = await this.visibleWards(actor);
      if (!('all' in vis) && !vis.wardIds.has(String(ward._id))) throw DENIED();
    }
    return { task, plan, ward };
  }

  /** Has the user a current assignment that covers the ward (owner candidates, needs-reassignment)? */
  private async worksInWard(userId: string, ward: Ward, roles = ['FRONTLINE', 'WARD_SUPERVISOR', 'IPC_OFFICER']): Promise<boolean> {
    const now = new Date();
    return !!(await ScopeAssignmentModel.exists({
      userId, role: { $in: roles }, validFrom: { $lte: now },
      $and: [
        { $or: [{ validTo: null }, { validTo: { $gt: now } }] },
        { $or: [{ 'scope.wardIds': String(ward._id) }, { 'scope.level': 'facility', 'scope.facilityId': String(ward.facilityId) }] },
      ],
    }));
  }

  // ------------------------------------------------------------------------------------- reads

  private dto(t: Task, wardId: string, extra: { needsReassignment?: boolean } = {}) {
    return {
      ...toTaskDto(t, wardId, this.d.programmeNow()),
      ...(t.lastReturnReason ? { lastReturnReason: { reasonCode: t.lastReturnReason.reasonCode, ...(t.lastReturnReason.reasonText ? { reasonText: t.lastReturnReason.reasonText } : {}) } } : {}),
      ...(extra.needsReassignment !== undefined ? { needsReassignment: extra.needsReassignment } : {}),
    };
  }

  async list(actor: TaskActor, q: TaskListQuery): Promise<Page<ReturnType<TaskService['dto']>>> {
    const filter: Record<string, unknown> = q.view === 'mine' ? { ownerUserId: actor.userId } : await this.scopeFilter(actor, q.wardId);
    if (q.view === 'mine' && q.wardId) {
      filter.planId = { $in: (await PlanModel.find({ wardId: oid(q.wardId) }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).map((p) => p._id) };
    }
    const and: Record<string, unknown>[] = [];
    if (q.planId) and.push({ planId: oid(q.planId) });
    if (q.riskLevel) and.push({ riskLevel: q.riskLevel });
    if (q.blocked !== undefined) and.push(q.blocked ? { blocked: { $ne: null } } : { blocked: null });
    if (q.state) and.push({ state: q.state });
    else if (q.view === 'review_queue') and.push({ state: 'EVIDENCE_SUBMITTED' });
    else if (q.view === 'validation_queue') and.push({ state: 'PENDING_VALIDATION' });
    else if (q.view !== 'ward') and.push({ state: { $in: OPEN_STATES } });
    if (q.view === 'overdue') and.push({ dueAt: { $lt: this.d.programmeNow() } });
    const after = decodeCursor(q.cursor);
    if (after) and.push({ _id: { $lt: after } });
    const query = and.length ? { $and: [filter, ...and] } : filter;

    const wardOf = async (tasks: Task[]) => {
      const plans = await PlanModel.find({ _id: { $in: [...new Set(tasks.map((t) => String(t.planId)))].map(oid) } }, { wardId: 1 }).lean<Plan[]>();
      return new Map(plans.map((p) => [String(p._id), String(p.wardId)]));
    };

    if (q.view === 'needs_reassignment') {
      // Owner left or lost the ward (HR import ends scopes): computed, bounded to 500 open tasks.
      const open = await TaskModel.find(query).sort({ _id: -1 }).limit(500).lean<Task[]>();
      const wardIds = await wardOf(open);
      const wards = new Map((await WardModel.find({ _id: { $in: [...new Set(wardIds.values())].map(oid) } }).lean<Ward[]>()).map((w) => [String(w._id), w]));
      const out: Task[] = [];
      for (const t of open) {
        const w = wards.get(wardIds.get(String(t.planId)) ?? '');
        if (w && !(await this.worksInWard(t.ownerUserId, w))) out.push(t);
        if (out.length > q.limit) break;
      }
      const page = out.slice(0, q.limit);
      return { items: page.map((t) => this.dto(t, wardIds.get(String(t.planId)) ?? '', { needsReassignment: true })), nextCursor: out.length > q.limit ? encodeCursor(page.at(-1)!._id) : null };
    }

    const docs = await TaskModel.find(query).sort({ _id: -1 }).limit(q.limit + 1).lean<Task[]>();
    const page = docs.slice(0, q.limit);
    const wardIds = await wardOf(page);
    return { items: page.map((t) => this.dto(t, wardIds.get(String(t.planId)) ?? '')), nextCursor: docs.length > q.limit ? encodeCursor(page.at(-1)!._id) : null };
  }

  async get(id: string, actor: TaskActor) {
    const { task, ward } = await this.visibleTask(id, actor);
    return this.dto(task, String(ward._id));
  }

  /** getTaskHistory (FR-031): ledger entries oldest first, with the decisions and escalations. */
  async history(id: string, actor: TaskActor) {
    const { task, ward } = await this.visibleTask(id, actor);
    const [records, decisions, escalations] = await Promise.all([
      LedgerRecordModel.find({ 'subject.type': 'task', 'subject.id': id }).sort({ seq: 1 }).limit(1000).lean<LedgerRecordDoc[]>(),
      DecisionModel.find({ taskId: task._id }).sort({ at: 1, _id: 1 }).lean<Decision[]>(),
      EscalationModel.find({ taskId: task._id }).sort({ raisedAt: 1 }).lean<Escalation[]>(),
    ]);
    const decisionAfter = (at: Date) => decisions.find((d) => d.at.getTime() >= at.getTime());
    const entries = records.map((r) => {
      const p = parseTransitionReason(r.reason);
      const hashes = r.action === 'task.evidence_submitted'
        ? (decisionAfter(r.at)?.evidenceHashes ?? task.currentEvidenceHashes ?? [])
        : r.action === 'task.accepted' || r.action === 'task.returned' || r.action === 'task.validated' || r.action === 'task.validation_returned'
          ? (decisions.find((d) => Math.abs(d.at.getTime() - r.at.getTime()) < 5_000)?.evidenceHashes ?? [])
          : [];
      return {
        at: iso(r.at)!, programmeAt: iso(r.programmeAt)!, actor: { userId: r.actor.userId, role: r.actor.role }, action: r.action.slice(0, 64),
        ...(p.fromState ? { fromState: p.fromState } : {}), ...(p.toState ? { toState: p.toState } : {}),
        ...(p.reasonCode ? { reasonCode: p.reasonCode } : {}), ...(p.reason ? { reason: p.reason } : {}),
        ...(hashes.length ? { evidenceHashes: [...hashes] } : {}),
        ...(p.previousOwnerUserId ? { previousOwnerUserId: p.previousOwnerUserId, newOwnerUserId: p.newOwnerUserId } : {}),
        ...(r.action === 'task.escalated' && r.subject.type === 'escalation' ? { escalationId: r.subject.id } : {}),
        ledgerSeq: r.seq, ledgerHash: r.hash,
      };
    });
    return { task: this.dto(task, String(ward._id)), entries, decisions: decisions.map(toDecisionDto), escalations: escalations.map(toEscalationDto) };
  }

  // ------------------------------------------------------------------------------------ writes

  private assertVersion(task: Task, ifMatch: number | undefined, wardId: string): void {
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required');
    if (ifMatch !== task.v) {
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this task since you opened it', { currentVersion: task.v, current: this.dto(task, wardId) });
    }
  }

  private async dependencies(task: Task): Promise<DependencyFact[]> {
    if (!task.dependsOnTaskIds?.length) return [];
    const deps = await TaskModel.find({ _id: { $in: task.dependsOnTaskIds } }, { title: 1, state: 1 }).lean<Task[]>();
    return deps.map((d) => ({ id: String(d._id), title: { en: d.title.en ?? '', ...(d.title.hi ? { hi: d.title.hi } : {}), ...(d.title.kn ? { kn: d.title.kn } : {}) }, state: d.state }));
  }

  /** Runs one state-machine command (everything but reopen). */
  async transition(id: string, cmd: TaskCommand | { action: 'submit_evidence'; submission: SubmissionInput }, ifMatch: number | undefined, actor: TaskActor) {
    const { task, plan, ward } = await this.visibleTask(id, actor);
    const wardId = String(ward._id);
    const facilityId = String(ward.facilityId);
    this.assertVersion(task, ifMatch, wardId);

    let command: TaskCommand;
    if (cmd.action === 'submit_evidence' && 'submission' in cmd) {
      const ids = new Set(cmd.submission.evidenceIds);
      if (cmd.submission.evidence.length !== ids.size || cmd.submission.evidence.some((e) => !ids.has(e.id))) {
        throw Problem.unprocessable('EVIDENCE_RULE_NOT_MET', 'Some evidence is not confirmed for this task yet');
      }
      command = { action: 'submit_evidence', evidence: cmd.submission.evidence };
    } else if (cmd.action === 'start') {
      command = { action: 'start', dependencies: await this.dependencies(task) };
    } else {
      command = cmd as TaskCommand;
    }
    const outcome = decideTransition(
      { state: task.state, ownerUserId: task.ownerUserId, riskLevel: task.riskLevel, rejectionCount: task.rejectionCount ?? 0, blocked: !!task.blocked, evidenceRule: task.evidenceRule },
      command,
      { userId: actor.userId, role: actor.role },
    );
    if (outcome.action === 'reassign' && !(await this.worksInWard(outcome.ownerUserId, ward, ['FRONTLINE', 'WARD_SUPERVISOR']))) {
      throw Problem.unprocessable('VALIDATION_FAILED', `${outcome.ownerUserId} does not work in this ward`, { errors: [{ path: 'newOwnerUserId', message: 'does not work in this ward' }] });
    }

    const who: LedgerActor = { userId: actor.userId, role: actor.role };
    const subject = { type: 'task' as const, id };
    const now = new Date();
    const evidence = command.action === 'submit_evidence' ? command.evidence : undefined;
    const note = cmd.action === 'submit_evidence' && 'submission' in cmd
      ? cmd.submission.note
      : command.action === 'reassign' || command.action === 'block' || command.action === 'unblock' ? command.reason : undefined;

    const after = await withTx(async (s) => {
      const set: Record<string, unknown> = { state: outcome.to, rejectionCount: outcome.rejectionCount, ownerUserId: outcome.ownerUserId };
      if (outcome.blocked !== undefined) set.blocked = outcome.blocked ? { reason: outcome.blocked.reason, by: actor.userId, at: now } : null;
      if (evidence) {
        set.currentEvidenceIds = evidence.map((e) => oid(e.id));
        set.currentEvidenceHashes = evidence.map((e) => e.sha256);
      }
      if (outcome.decision && (outcome.decision.kind === 'return' || outcome.decision.kind === 'validation_return')) {
        set.lastReturnReason = { reasonCode: outcome.decision.reasonCode, ...(outcome.decision.reasonText ? { reasonText: outcome.decision.reasonText } : {}) };
      }
      const next = await TaskModel.findOneAndUpdate({ _id: task._id, v: task.v, state: task.state }, { $set: set, $inc: { v: 1 } }, { new: true, session: s, lean: true });
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this task since you opened it');
      const nextTask = next as Task;
      const afterHash = contentHash(this.dto(nextTask, wardId));

      let decisionId: string | undefined;
      if (outcome.decision) {
        const [dec] = await DecisionModel.create([{
          taskId: task._id, kind: outcome.decision.kind, actorUserId: actor.userId, role: actor.role, reasonCode: outcome.decision.reasonCode,
          ...(outcome.decision.reasonText ? { reasonText: outcome.decision.reasonText } : {}),
          evidenceIds: task.currentEvidenceIds ?? [], evidenceHashes: task.currentEvidenceHashes ?? [], at: now, v: 0,
        }], { session: s });
        decisionId = String(dec!._id);
      }

      await this.ledgerFor(outcome, task, nextTask, { who, subject, wardId, afterHash, note }, s);
      await this.eventFor(outcome, task, nextTask, { wardId, facilityId, decisionId, evidence, who }, s);
      if (decisionId && (outcome.action === 'return' || outcome.action === 'validation_return')) {
        for (const h of this.returnHooks) {
          await h({ task: nextTask, wardId, facilityId, kind: outcome.action, rejectionCount: outcome.rejectionCount, decisionId, actor: who, session: s });
        }
      }
      return nextTask;
    });
    if (outcome.to !== outcome.from) this.reconcile?.trigger(String(plan._id));
    return this.dto(after, wardId);
  }

  private async ledgerFor(
    o: TransitionOutcome, before: Task, after: Task,
    c: { who: LedgerActor; subject: { type: 'task'; id: string }; wardId: string; afterHash: string; note?: string }, s: ClientSession,
  ) {
    const { who, subject, afterHash } = c;
    const beforeHash = contentHash(this.dto(before, c.wardId));
    const text = o.decision?.reasonText ?? c.note;
    if (o.action === 'accept') {
      // VERIFIED is recorded, then the task moves at once to CLOSED or PENDING_VALIDATION (FR-013).
      await this.d.ledger.append({ actor: who, action: 'task.accepted', subject, beforeHash, reason: transitionReason({ from: o.from, to: 'VERIFIED', reasonCode: o.decision!.reasonCode, text }) }, s);
      await this.d.ledger.append({
        actor: who, action: o.to === 'CLOSED' ? 'task.closed' : 'task.pending_validation', subject, afterHash,
        reason: transitionReason({ from: 'VERIFIED', to: o.to, text: o.to === 'CLOSED' ? 'normal risk: no second validation' : `${after.riskLevel} risk: second validation required` }),
      }, s);
      return;
    }
    let reason: string;
    if (o.action === 'reassign') reason = transitionReason({ previousOwner: o.previousOwnerUserId, newOwner: o.ownerUserId, text });
    else if (o.action === 'block' || o.action === 'unblock') reason = transitionReason({ from: o.from, to: o.to, text: o.blocked ? o.blocked.reason : text ?? 'blocked flag cleared' });
    else reason = transitionReason({ from: o.from, to: o.to, reasonCode: o.decision?.reasonCode, text });
    await this.d.ledger.append({ actor: who, action: o.ledgerAction, subject, beforeHash, afterHash, reason }, s);
  }

  private async eventFor(
    o: TransitionOutcome, before: Task, after: Task,
    c: { wardId: string; facilityId: string; decisionId?: string; evidence?: EvidenceFact[]; who: LedgerActor }, s: ClientSession,
  ) {
    if (!o.event) return;
    const common = { taskId: String(after._id), planId: String(after.planId), wardId: c.wardId, facilityId: c.facilityId, riskLevel: after.riskLevel };
    let payload: Record<string, unknown>;
    switch (o.event) {
      case 'ipc.task.evidence_submitted':
        payload = {
          ...common, fromState: o.from, toState: 'EVIDENCE_SUBMITTED', evidenceIds: (c.evidence ?? []).map((e) => e.id),
          evidenceHashes: (c.evidence ?? []).map((e) => e.sha256), gpsMissingCount: (c.evidence ?? []).filter((e) => e.gpsUnavailable).length,
        };
        break;
      case 'ipc.task.decided':
      case 'ipc.task.validated':
        payload = {
          ...common, decisionId: c.decisionId, kind: o.decision!.kind, reasonCode: o.decision!.reasonCode, fromState: o.from, toState: o.to,
          rejectionCount: o.rejectionCount, evidenceHashes: [...(before.currentEvidenceHashes ?? [])],
        };
        break;
      case 'ipc.task.assigned':
        payload = {
          ...common, assignment: 'reassigned', ownerUserId: o.ownerUserId, previousOwnerUserId: o.previousOwnerUserId ?? null, state: after.state,
          dueAt: after.dueAt.toISOString(), secondValidation: after.secondValidation,
        };
        break;
    }
    await this.d.outbox.enqueue({ type: o.event, key: c.wardId, actor: c.who, subject: { type: 'task', id: String(after._id) }, payload }, s);
  }

  /**
   * reopenTask (FR-015): the closed task is not changed; a new linked task (reopenedFromTaskId) is
   * added to the plan with a numbered plan revision, ledger records and `ipc.task.assigned` +
   * `ipc.plan.revised`, all in one transaction.
   */
  async reopen(id: string, body: { reason: string; ownerUserId?: string; dueAt?: string }, ifMatch: number | undefined, actor: TaskActor) {
    const { task, plan, ward } = await this.visibleTask(id, actor);
    const wardId = String(ward._id);
    const facilityId = String(ward.facilityId);
    this.assertVersion(task, ifMatch, wardId);
    const outcome = decideTransition(
      { state: task.state, ownerUserId: task.ownerUserId, riskLevel: task.riskLevel, rejectionCount: task.rejectionCount ?? 0, blocked: !!task.blocked, evidenceRule: task.evidenceRule },
      { action: 'reopen', reason: body.reason }, { userId: actor.userId, role: actor.role },
    );
    if (plan.status !== 'active') throw Problem.conflict('INVALID_TRANSITION', 'Tasks can be reopened only in an active plan');
    const owner = body.ownerUserId ?? task.ownerUserId;
    if (!(await this.worksInWard(owner, ward))) {
      throw Problem.unprocessable('VALIDATION_FAILED', `${owner} does not work in this ward`, { errors: [{ path: 'ownerUserId', message: 'does not work in this ward' }] });
    }
    const risk = await RiskDefaultModel.findOne({ riskLevel: task.riskLevel }).lean<RiskDefault>();
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(this.d.programmeNow().getTime() + (risk?.dueDays ?? 7) * DAY_MS);
    const who: LedgerActor = { userId: actor.userId, role: actor.role };
    const _id = new Types.ObjectId();
    const revision = (plan.revision ?? 0) + 1;

    const created = await withTx(async (s) => {
      const p = await PlanModel.findOneAndUpdate({ _id: plan._id, status: 'active', revision: plan.revision }, { $set: { revision }, $inc: { v: 1 } }, { new: true, session: s, lean: true });
      if (!p) throw Problem.conflict('VERSION_CONFLICT', 'The plan changed meanwhile; reload and try again');
      // The closed task must still be closed and unchanged at commit time (FR-015).
      if (!(await TaskModel.exists({ _id: task._id, v: task.v, state: 'CLOSED' }).session(s))) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this task since you opened it');
      const [doc] = await TaskModel.create([{
        _id, planId: plan._id, taskKey: task.taskKey, title: task.title, ...(task.sourceQuestionKey ? { sourceQuestionKey: task.sourceQuestionKey } : {}),
        riskLevel: task.riskLevel, ownerUserId: owner, dueAt, dependsOnTaskIds: [], evidenceRule: task.evidenceRule, secondValidation: task.secondValidation,
        state: 'ASSIGNED', rejectionCount: 0, blocked: null, reopenedFromTaskId: task._id, currentEvidenceIds: [], syncState: 'pending', v: 0,
      }], { session: s });
      const t = doc!.toObject() as Task;
      await PlanRevisionModel.create([{
        planId: plan._id, revision, actorUserId: actor.userId, role: actor.role, reason: body.reason, source: 'officer',
        changes: [{ op: 'add', taskId: _id, after: { reopenedFromTaskId: id, ownerUserId: owner, dueAt: dueAt.toISOString(), riskLevel: task.riskLevel } }], v: 0,
      }], { session: s });
      await this.d.ledger.append({ actor: who, action: 'task.reopened', subject: { type: 'task', id }, reason: transitionReason({ from: 'CLOSED', to: 'CLOSED', text: `reopened as ${String(_id)}: ${body.reason}` }) }, s);
      await this.d.ledger.append({
        actor: who, action: 'task.assigned', subject: { type: 'task', id: String(_id) },
        reason: `reopened from ${id}: owner ${owner}, due ${dueAt.toISOString()}`.slice(0, 500), afterHash: contentHash(this.dto(t, wardId)),
      }, s);
      await this.d.ledger.append({ actor: who, action: 'plan.revised', subject: { type: 'plan', id: String(plan._id) }, reason: `r${revision}: ${body.reason}`.slice(0, 500) }, s);
      await this.d.outbox.enqueue({
        type: outcome.event!, key: wardId, actor: who, subject: { type: 'task', id: String(_id) },
        payload: {
          taskId: String(_id), planId: String(plan._id), wardId, facilityId, riskLevel: t.riskLevel, assignment: 'reopened', ownerUserId: owner,
          previousOwnerUserId: null, state: 'ASSIGNED', dueAt: dueAt.toISOString(), secondValidation: t.secondValidation, reopenedFromTaskId: id,
        },
      }, s);
      await this.d.outbox.enqueue({
        type: 'ipc.plan.revised', key: wardId, actor: who, subject: { type: 'plan', id: String(plan._id) },
        payload: { planId: String(plan._id), wardId, facilityId, revision, source: 'officer', changes: [{ op: 'add', taskId: String(_id) }] },
      }, s);
      return t;
    });
    this.reconcile?.trigger(String(plan._id));
    return this.dto(created, wardId);
  }
}
