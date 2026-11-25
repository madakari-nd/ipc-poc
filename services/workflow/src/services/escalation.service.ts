import { Types, type ClientSession } from 'mongoose';
import { Problem, escalationSweepRuns, escalationSweepFailures, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import { escalateTarget, type EscalationRuleLike, type TaskFacts } from '../domain/escalation.js';
import type { Role } from '../domain/scope.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  DecisionModel, EscalationModel, EscalationRuleModel, FacilityModel, PlanModel, ScopeAssignmentModel, TaskModel, WardModel,
  type Escalation, type Task, type Ward,
} from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import { NotificationService } from './notification.service.js';
import type { Outbox } from './outbox.publisher.js';

export type SweepTrigger = 'schedule' | 'on_return' | 'demo_run_now';

/** One open task with the ward/facility it belongs to (target scope resolution). */
export interface EscalationFacts {
  task: Task;
  ward: Ward;
  facilityId: string;
}

/**
 * Escalation (US5, FR-020, FR-021; research E12). Rules are configurable (EscalationRule), defaulting
 * to proposal A11: R1 critical overdue ≥ 48 h → IPC officer; R2 critical overdue ≥ 7 days → district
 * quality manager; R3 returned 2 times → the level above whoever returned it. The sweep runs from the
 * ELEVATE scheduler (hourly) or on demand in demo mode; R3 also fires from the on-return hook inside
 * the task transaction. Every escalation is one transaction: the Escalation record (idempotent on
 * task + rule + level), the in-app + email notifications, the ledger record and the `ipc.task.escalated`
 * outbox event. Escalation never changes the task owner, state or history.
 *
 * Targets: users holding the target role whose scope covers the task's ward. When the target role is
 * vacant, the escalation goes to the next level up and `vacantTargetFlag` is set (spec edge case).
 */
export class EscalationService {
  private readonly notifications: NotificationService;

  constructor(
    private readonly d: {
      ledger: LedgerService;
      outbox: Outbox;
      programmeNow: () => Date;
      notifications?: NotificationService;
      logger?: Logger;
      /** ELEVATE user id → email (for the email channel). Injected by the server. */
      emailOf?: (userId: string) => Promise<string | undefined>;
    },
  ) {
    this.notifications = d.notifications ?? new NotificationService({ outbox: d.outbox, logger: d.logger });
  }

  // ------------------------------------------------------------------------------------- helpers

  /** Open tasks in active plans (closed tasks and drafts are never escalated). */
  private async openTasks(limit = 2000): Promise<EscalationFacts[]> {
    const plans = await PlanModel.find({ status: 'active' }, { _id: 1, wardId: 1 }).lean<{ _id: Types.ObjectId; wardId: Types.ObjectId }[]>();
    if (!plans.length) return [];
    const wardIds = [...new Set(plans.map((p) => String(p.wardId)))];
    const wards = await WardModel.find({ _id: { $in: wardIds.map(oid) } }).lean<Ward[]>();
    const wardById = new Map(wards.map((w) => [String(w._id), w]));
    const tasks = await TaskModel.find({ planId: { $in: plans.map((p) => p._id) }, state: { $ne: 'CLOSED' } }).sort({ _id: 1 }).limit(limit).lean<Task[]>();
    const out: EscalationFacts[] = [];
    for (const t of tasks) {
      const plan = plans.find((p) => String(p._id) === String(t.planId));
      const ward = plan ? wardById.get(String(plan.wardId)) : undefined;
      if (ward) out.push({ task: t, ward, facilityId: String(ward.facilityId) });
    }
    return out;
  }

  /** Users currently holding `role` with a scope that covers the ward. */
  private async targetUsers(role: Role, ward: Ward): Promise<string[]> {
    const now = new Date();
    const wardId = String(ward._id);
    const facilityId = String(ward.facilityId);
    const facility = await FacilityModel.findById(facilityId, { districtCode: 1 }).lean<{ districtCode: string }>();
    const districtCode = facility?.districtCode;
    const active = [{ validTo: null }, { validTo: { $gt: now } }] as const;
    const scope: Record<string, unknown>[] = [
      { 'scope.level': 'state' },
      { 'scope.level': 'facility', 'scope.facilityId': facilityId },
      ...(districtCode ? [{ 'scope.level': 'district', 'scope.districtCode': districtCode }] : []),
      { 'scope.level': 'wards', 'scope.wardIds': wardId },
    ];
    const docs = await ScopeAssignmentModel.find({
      role,
      validFrom: { $lte: now },
      $and: [{ $or: [...active] }, { $or: scope }],
    }).lean<{ userId: string }[]>();
    return [...new Set(docs.map((d) => d.userId))];
  }

  /** The target role and level; when the target role is vacant, the next rung up, flagged. */
  private async resolveTarget(role: Role, ward: Ward): Promise<{ role: Role; level: number; vacant: boolean } | null> {
    const users = await this.targetUsers(role, ward);
    if (users.length) return { role, level: roleLevel(role), vacant: false };
    const up = levelAboveRole(role);
    if (!up) return null;
    return { role: up, level: roleLevel(up), vacant: true };
  }

  // ------------------------------------------------------------------------------------ core write

  /**
   * Writes one escalation for a fired rule, inside the caller's transaction. Returns null when the
   * (task, rule, level) already exists (idempotent) or there is no valid target.
   */
  private async raise(
    facts: EscalationFacts,
    ruleCode: string,
    channels: ('inapp' | 'email' | 'sms')[],
    target: { role: Role; level: number; vacant: boolean },
    reason: string,
    actor: LedgerActor,
    session: ClientSession,
  ): Promise<Escalation | null> {
    if (await EscalationModel.exists({ taskId: facts.task._id, ruleCode, level: target.level }).session(session)) return null;

    const targetUserIds = await this.targetUsers(target.role, facts.ward);
    const [doc] = await EscalationModel.create([{
      taskId: facts.task._id, ruleCode, level: target.level, targetRole: target.role,
      targetUserIds, raisedAt: new Date(), raisedBy: actor.userId, reason: reason.slice(0, 500),
      notificationIds: [], vacantTargetFlag: target.vacant, v: 0,
    }], { session });
    const escalation = doc!.toObject() as Escalation;

    // Notify every target user on each rule channel. A vacant target gets nobody to notify.
    const notificationIds: Types.ObjectId[] = [];
    for (const userId of targetUserIds) {
      const email = this.d.emailOf ? await this.d.emailOf(userId) : undefined;
      for (const channel of channels) {
        const n = await this.notifications.notify({
          userId,
          ...(email && channel === 'email' ? { email } : {}),
          channel,
          templateCode: 'task.escalated',
          params: { taskId: String(facts.task._id), rule: ruleCode, level: target.level, reason },
          subject: { type: 'task', id: String(facts.task._id) },
          actor,
          programmeNow: this.d.programmeNow,
        }, session);
        notificationIds.push(n._id);
      }
    }
    if (notificationIds.length) {
      await EscalationModel.updateOne({ _id: escalation._id }, { $set: { notificationIds }, $inc: { v: 1 } }, { session });
      escalation.notificationIds = notificationIds;
    }

    const afterHash = contentHash(toEscalationDto(escalation));
    await this.d.ledger.append({
      actor,
      action: 'task.escalated',
      subject: { type: 'escalation', id: String(escalation._id) },
      reason: `rule ${ruleCode} level ${target.level} → ${target.role}${target.vacant ? ' (vacant: escalated up)' : ''}: ${reason}`.slice(0, 500),
      afterHash,
    }, session);

    await this.d.outbox.enqueue({
      type: 'ipc.task.escalated',
      key: String(facts.ward._id),
      actor,
      subject: { type: 'task', id: String(facts.task._id) },
      payload: {
        escalationId: String(escalation._id),
        taskId: String(facts.task._id),
        planId: String(facts.task.planId),
        wardId: String(facts.ward._id),
        facilityId: facts.facilityId,
        riskLevel: facts.task.riskLevel,
        ruleCode,
        level: target.level,
        targetRole: target.role,
        targetUserCount: targetUserIds.length,
        vacantTargetFlag: target.vacant,
        ownerUserId: facts.task.ownerUserId,
        taskState: facts.task.state,
        ...(facts.task.dueAt ? { dueAt: facts.task.dueAt.toISOString() } : {}),
        ...(overdueHours(facts.task, this.d.programmeNow()) !== undefined ? { overdueHours: overdueHours(facts.task, this.d.programmeNow())! } : {}),
        rejectionCount: facts.task.rejectionCount,
        channels,
      },
    }, session);

    return escalation;
  }

  // ------------------------------------------------------------------------------------- operations

  /**
   * Runs every active rule against every open task. Idempotent per (task, ruleCode, level), so a
   * repeated sweep (schedule + demo) never duplicates. Returns the sweep result.
   */
  async sweep(trigger: SweepTrigger, actor: LedgerActor = { userId: 'system', role: 'SYSTEM' }): Promise<SweepResult> {
    escalationSweepRuns.inc();
    const started = Date.now();
    try {
      const facts = await this.openTasks();
      const rules = (await EscalationRuleModel.find({ active: true }).lean<EscalationRuleLike[]>())
        .sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)));
      const nowMs = this.d.programmeNow().getTime();
      const created: Escalation[] = [];
      let skippedDuplicates = 0;
      let vacantTargets = 0;

      for (const f of facts) {
        const decider = await lastReturnerRole(f.task._id);
        for (const rule of rules) {
          const t: TaskFacts = {
            id: String(f.task._id), state: f.task.state, riskLevel: f.task.riskLevel, dueAt: f.task.dueAt, rejectionCount: f.task.rejectionCount,
          };
          const hit = escalateTarget(rule, t, nowMs, decider);
          if (!hit) continue;
          const target = await this.resolveTarget(hit.targetRole, f.ward);
          if (!target) continue;
          if (target.vacant) vacantTargets += 1;
          const esc = await withTx((s) => this.raise(f, hit.ruleCode, hit.channels, target,
            `${rule.condition.type === 'overdue' ? 'overdue' : 'repeated rejection'} (${rule.condition.thresholdHours ?? rule.condition.thresholdCount})`, actor, s));
          if (esc) created.push(esc);
          else skippedDuplicates += 1;
        }
      }
      this.d.logger?.info({ trigger, evaluatedTasks: facts.length, created: created.length, skippedDuplicates, vacantTargets, durationMs: Date.now() - started }, 'escalation sweep completed');
      return {
        runAt: new Date(), programmeAt: this.d.programmeNow(), trigger, evaluatedTasks: facts.length,
        created: created.map(toEscalationDto), skippedDuplicates, vacantTargets,
      };
    } catch (err) {
      escalationSweepFailures.inc();
      this.d.logger?.error({ trigger, err }, 'escalation sweep failed');
      throw err;
    }
  }

  /**
   * US5 on-return hook (registered on TaskService): R3 fires inside the return transaction, so the
   * escalation commits atomically with the rejection that triggered it.
   */
  async onReturn(e: {
    task: Task; wardId: string; facilityId: string; kind: 'return' | 'validation_return'; rejectionCount: number;
    decisionId: string; actor: LedgerActor; session: ClientSession;
  }): Promise<void> {
    const rule = await EscalationRuleModel.findOne({ code: 'R3', active: true }).lean<EscalationRuleLike>();
    if (!rule) return;
    const ward = await WardModel.findById(e.wardId).lean<Ward>();
    if (!ward) return;
    const t: TaskFacts = {
      id: String(e.task._id), state: e.task.state, riskLevel: e.task.riskLevel, dueAt: e.task.dueAt, rejectionCount: e.rejectionCount,
    };
    const hit = escalateTarget(rule, t, this.d.programmeNow().getTime(), e.actor.role as Role);
    if (!hit) return;
    const target = await this.resolveTarget(hit.targetRole, ward);
    if (!target) return;
    await this.raise({ task: e.task, ward, facilityId: e.facilityId }, hit.ruleCode, hit.channels, target,
      `returned ${e.rejectionCount} times`, e.actor, e.session);
  }

  /** A ward supervisor raises a manual escalation for a blocker (not a task state change). */
  async manual(taskId: string, reason: string, actor: { userId: string; role: Role }) {
    const task = await TaskModel.findById(taskId).lean<Task>();
    const plan = task ? await PlanModel.findById(task.planId).lean<{ wardId: Types.ObjectId }>() : null;
    const ward = task && plan ? await WardModel.findById(plan.wardId).lean<Ward>() : null;
    if (!task || !plan || !ward) throw Problem.notFound('No such task');
    const target = await this.resolveTarget('IPC_OFFICER', ward);
    if (!target) throw Problem.conflict('INVALID_TRANSITION', 'No escalation target available for this task');
    const esc = await withTx((s) => this.raise(
      { task, ward, facilityId: String(ward.facilityId) },
      'manual', ['inapp', 'email'], target, reason,
      { userId: actor.userId, role: actor.role }, s,
    ));
    return toEscalationDto(esc!);
  }

  /** List escalations, scoped to the caller (targeted to me, or within my scope). */
  async list(actor: { userId: string; role: Role; wardIds?: string[]; allScopes?: boolean }, q: { taskId?: string; wardId?: string; targetedToMe?: boolean; cursor?: string; limit: number }) {
    const filter: Record<string, unknown> = {};
    if (q.taskId) filter.taskId = oid(q.taskId);
    if (q.targetedToMe) filter.targetUserIds = actor.userId;
    if (!actor.allScopes) {
      // Scope: escalations of tasks in wards the caller may see, or targeting the caller directly.
      const wardIds = actor.wardIds ?? [];
      if (wardIds.length) filter.$or = [{ taskId: { $in: await taskIdsOfWards(wardIds) } }, { targetUserIds: actor.userId }];
      else filter.targetUserIds = actor.userId;
    }
    if (q.cursor) filter._id = { $lt: oid(q.cursor) };
    const docs = await EscalationModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<Escalation[]>();
    const page = docs.slice(0, q.limit);
    return {
      items: page.map(toEscalationDto),
      nextCursor: docs.length > q.limit ? String(page[page.length - 1]!._id) : null,
    };
  }
}

// -------------------------------------------------------------------------------------------- helpers

const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));

function roleLevel(role: Role): number {
  return { WARD_SUPERVISOR: 1, IPC_OFFICER: 2, DISTRICT_QM: 3, STATE_ADMIN: 4, FRONTLINE: 0, MENTOR: 0, EXTERNAL_AUDITOR: 0 }[role]!;
}

function levelAboveRole(role: Role): Role | undefined {
  return role === 'WARD_SUPERVISOR' ? 'IPC_OFFICER' : role === 'IPC_OFFICER' ? 'DISTRICT_QM' : role === 'DISTRICT_QM' ? 'STATE_ADMIN' : undefined;
}

function overdueHours(task: Task, now: Date): number | undefined {
  const ms = now.getTime() - task.dueAt.getTime();
  return ms > 0 ? Math.floor(ms / 3_600_000) : undefined;
}

/** The role of the most recent return/validation_return decision for a task. */
async function lastReturnerRole(taskId: Types.ObjectId): Promise<Role | undefined> {
  const d = await DecisionModel.findOne({ taskId, kind: { $in: ['return', 'validation_return'] } }).sort({ at: -1 }).lean<{ role: string }>();
  return d?.role as Role | undefined;
}

async function taskIdsOfWards(wardIds: string[]): Promise<Types.ObjectId[]> {
  const plans = await PlanModel.find({ wardId: { $in: wardIds.map(oid) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
  return plans.map((p) => p._id);
}

export interface SweepResult {
  runAt: Date; programmeAt: Date; trigger: SweepTrigger; evaluatedTasks: number;
  created: ReturnType<typeof toEscalationDto>[]; skippedDuplicates: number; vacantTargets: number;
}

export function toEscalationDto(e: Escalation) {
  return {
    id: String(e._id), v: e.v, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
    taskId: String(e.taskId), ruleCode: e.ruleCode, level: e.level, targetRole: e.targetRole,
    targetUserIds: e.targetUserIds.map(String), raisedAt: e.raisedAt.toISOString(), raisedBy: e.raisedBy,
    ...(e.reason ? { reason: e.reason } : {}),
    notificationIds: e.notificationIds.map(String), vacantTargetFlag: !!e.vacantTargetFlag,
  };
}
