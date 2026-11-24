import { Types } from 'mongoose';
import type { Role, Scope } from '../domain/scope.js';
import {
  AssessmentContextModel, EscalationModel, NotificationModel, PlanModel, ScopeAssignmentModel, SupportRequestModel, TaskModel, WardModel,
  type ScopeAssignmentDoc,
} from '../domain/models/index.js';
import { visibleFacilityIds, type ActorScope } from './admin.service.js';

/**
 * "What needs me now" home cards (FR-036, T045 + US5). Every count is computed from programme state
 * within the acting user's server-derived scope. The Edge filters to the cards the active role may
 * act on; the workflow returns the counts for the role's full card set.
 */
export class HomeService {
  constructor(private readonly programmeNow: () => Date) {}

  private async wardScope(a: ActorScope): Promise<{ all: true } | { wardIds: string[] }> {
    const vis = await visibleFacilityIds(a);
    if ('all' in vis) return { all: true };
    const wardIds = new Set<string>();
    vis.wardIds?.forEach((w) => wardIds.add(w));
    const wards = await WardModel.find({ facilityId: { $in: [...vis.facilityIds].map((s) => new Types.ObjectId(s)) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    wards.forEach((w) => wardIds.add(String(w._id)));
    return { wardIds: [...wardIds] };
  }

  /** Plan ids of the caller's wards (empty when the caller has no ward scope). */
  private async wardPlanIds(wardIds: string[]): Promise<Types.ObjectId[]> {
    if (!wardIds.length) return [];
    return (await PlanModel.find({ wardId: { $in: wardIds.map((s) => new Types.ObjectId(s)) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).map((p) => p._id);
  }

  async summary(userId: string, role: Role): Promise<{ cards: { kind: string; count: number; href?: string }[]; programmeNow: string }> {
    const assignments = (await ScopeAssignmentModel.find({ userId }).sort({ validFrom: 1 }).lean<ScopeAssignmentDoc[]>())
      .map((a) => ({ role: a.role, scope: a.scope as Scope }));
    const actor: ActorScope = { role, assignments };
    const ws = await this.wardScope(actor);
    const now = this.programmeNow();

    const allWards = 'all' in ws;
    const wardIds = allWards ? [] : ws.wardIds;
    const planIds = await this.wardPlanIds(wardIds);
    const hasPlans = allWards || planIds.length > 0;
    const planFilter = hasPlans ? (allWards ? {} : { planId: { $in: planIds } }) : { planId: { $in: [] } };

    const [myTasks, overdueCritical, reviewQueue, validationQueue, draftPlans, escalations, unread, held, supportReq] = await Promise.all([
      TaskModel.countDocuments({ ownerUserId: userId, state: { $ne: 'CLOSED' } }),
      TaskModel.countDocuments({ ...planFilter, riskLevel: 'critical', state: { $ne: 'CLOSED' }, dueAt: { $lt: now } }),
      TaskModel.countDocuments({ ...planFilter, state: 'EVIDENCE_SUBMITTED' }),
      TaskModel.countDocuments({ ...planFilter, state: 'PENDING_VALIDATION' }),
      allWards ? PlanModel.countDocuments({ status: 'draft' }) : PlanModel.countDocuments({ ...(planIds.length ? { _id: { $in: planIds } } : { _id: { $in: [] } }), status: 'draft' }),
      EscalationModel.countDocuments(await this.escalationFilter(actor, userId, wardIds)),
      NotificationModel.countDocuments({ userId, status: { $ne: 'read' } }),
      AssessmentContextModel.countDocuments({ assessorType: 'external', releaseState: 'held' }),
      this.countSupport(actor, wardIds),
    ]);

    const cards: { kind: string; count: number; href?: string }[] = [];
    const push = (kind: string, count: number, href?: string) => { if (count > 0) cards.push({ kind, count, ...(href ? { href } : {}) }); };
    push('my_tasks', myTasks, '/tasks');
    push('overdue_critical', overdueCritical, '/tasks?view=overdue');
    push('review_queue', reviewQueue, '/reviews');
    push('validation_queue', validationQueue, '/validations');
    push('draft_plans', draftPlans, '/plans');
    push('escalations', escalations, '/escalations');
    push('unread_notifications', unread, '/notifications');
    push('held_results', held, '/assessments');
    if (supportReq > 0) push('support_requests', supportReq, '/support');
    return { cards, programmeNow: now.toISOString() };
  }

  /** Escalations visible to the caller: in their wards, or targeted to them. */
  private async escalationFilter(actor: ActorScope, userId: string, wardIds: string[]): Promise<Record<string, unknown>> {
    const plans = await this.wardPlanIds(wardIds);
    const byWard = plans.length ? { taskId: { $in: plans } } : null;
    const byTarget = { targetUserIds: userId };
    if (actor.role === 'STATE_ADMIN') return {};
    if (byWard) return { $or: [byWard, byTarget] };
    return byTarget;
  }

  private async countSupport(actor: ActorScope, wardIds: string[]): Promise<number> {
    if (actor.role === 'MENTOR') return 0;
    const filter: Record<string, unknown> = { status: { $in: ['open', 'requested'] } };
    if (wardIds.length) filter.wardId = { $in: wardIds.map((s) => new Types.ObjectId(s)) };
    return SupportRequestModel.countDocuments(filter);
  }
}
