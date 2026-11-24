import type { ClientSession } from 'mongoose';
import { ObservationSubmissionEventSchema, eventHasScores, type ObservationSubmissionEvent } from '@ipc/elevate-client';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import {
  AssessmentContextModel, ChecklistVersionModel, CycleModel, PlanModel, WardModel,
  type AssessmentContext, type ChecklistVersion, type Cycle, type Ward,
} from '../domain/models/index.js';
import { countsForPlanning, scoreSubmission, type CatalogueQuestionLike, type EventAnswer } from '../domain/plan.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { PlanService } from '../services/plan.service.js';
import { BaseConsumer, type ConsumerDeps } from './base.consumer.js';

const SYSTEM: LedgerActor = { userId: 'system', role: 'SYSTEM' };

export interface ObservationConsumerDeps extends ConsumerDeps {
  /** `elevate_observations_<env>` (E8). */
  topic: string;
  plans: Pick<PlanService, 'draftFromCompletion'>;
  ledger: Pick<LedgerService, 'append'>;
}

type Completed = ObservationSubmissionEvent & { status: 'completed' };

/**
 * ELEVATE observation completion → programme assessment result → draft plan (T084; FR-011, E8).
 * - only `completed` events of this profile's ELEVATE org count; other statuses are filtered;
 * - dedupe on (submission id, `completed`) in the same transaction as every write (redeliveries
 *   and the same completion published twice produce one draft, US3 AS3);
 * - scores come from the event; without them the catalogue pass marks score the answers;
 * - the AssessmentContext (US2) is completed with scores and findings; a submission made
 *   directly in ELEVATE gets one created from the event;
 * - the draft (or "no actions needed" / "same cycle") is decided by the plan domain.
 */
export class ObservationCompletedConsumer extends BaseConsumer<Completed | { status?: string; orgId?: string }> {
  readonly topic: string;

  constructor(private readonly o: ObservationConsumerDeps) {
    super(o);
    this.topic = o.topic;
  }

  protected override parse(value: string) {
    const raw = JSON.parse(value) as { status?: string; orgId?: string };
    // Only completions are validated: a malformed completion is dead-lettered, other statuses are ignored.
    return raw.status === 'completed' ? (ObservationSubmissionEventSchema.parse(raw) as Completed) : raw;
  }

  /** Non-completion events are treated as out of scope (filtered, no dedupe marker). */
  protected orgIdOf(e: Completed | { status?: string; orgId?: string }) {
    return e.status === 'completed' ? e.orgId : undefined;
  }

  protected dedupeOf(e: Completed | { status?: string }) {
    return { key: (e as Completed)._id, status: 'completed' };
  }

  protected override correlationOf(e: Completed | { status?: string }) {
    const id = (e as Completed)._id;
    return id ? `obs-${id}` : undefined;
  }

  private async checklistFor(e: Completed, ctx: AssessmentContext | null, s: ClientSession): Promise<ChecklistVersion | null> {
    if (ctx) return ChecklistVersionModel.findById(ctx.checklistVersionId).session(s).lean<ChecklistVersion>();
    return (await ChecklistVersionModel.findOne({ elevateSolutionId: e.solutionId }).session(s).lean<ChecklistVersion>())
      ?? ChecklistVersionModel.findOne({ status: 'published' }).sort({ version: -1 }).session(s).lean<ChecklistVersion>();
  }

  protected async handle(raw: Completed | { status?: string }, s: ClientSession): Promise<void> {
    const e = raw as Completed;
    const ward = await WardModel.findOne({ elevateEntityId: e.entityId }).session(s).lean<Ward>();
    const cycle = await CycleModel.findOne({ 'elevateSolutionIds.observation': e.solutionId }).session(s).lean<Cycle>();
    if (!ward || !cycle) {
      this.o.logger.debug({ submission: e._id, entity: e.entityId, solution: e.solutionId }, 'completion is not a programme ward assessment; ignored');
      return;
    }
    let ctx = await AssessmentContextModel.findOne({ elevateSubmissionId: e._id }).session(s).lean<AssessmentContext>();
    const checklist = await this.checklistFor(e, ctx, s);
    if (!checklist) throw new Error(`no checklist version for solution ${e.solutionId}`);

    const score = scoreSubmission(checklist.questions as CatalogueQuestionLike[], (e.answers ?? {}) as Record<string, EventAnswer>, { eventScored: eventHasScores(e) });
    const completedAt = new Date(e.completedDate ?? e.ratingCompletedAt ?? Date.now());
    // External-auditor results are for comparison and release only (FR-024a, A12): never a plan,
    // never the cycle's first assessment. A completion without a context is a hospital submission.
    const internal = countsForPlanning({ assessorType: ctx?.assessorType ?? 'internal' });
    // First completed INTERNAL assessment of the ward in the cycle, and no plan yet for (ward, cycle) (FR-011).
    const earlier = await AssessmentContextModel.exists({
      wardId: ward._id, cycleId: cycle._id, status: 'completed', assessorType: { $ne: 'external' }, ...(ctx ? { _id: { $ne: ctx._id } } : {}),
    }).session(s);
    const planned = await PlanModel.exists({ wardId: ward._id, cycleId: cycle._id, status: { $in: ['draft', 'active', 'closed'] } }).session(s);
    const firstInCycle = internal && !earlier && !planned;

    const result = {
      status: 'completed' as const, completedAt: ctx?.completedAt ?? completedAt, isBaselineForCycle: firstInCycle,
      scores: { total: score.total, bySection: score.bySection }, failedQuestionKeys: score.failedQuestionKeys,
      questionScores: score.byQuestion,
    };
    if (!ctx) {
      const [doc] = await AssessmentContextModel.create([{
        elevateObservationId: e.observationId, elevateSubmissionId: e._id, submissionNumber: e.submissionNumber,
        wardId: ward._id, facilityId: ward.facilityId, cycleId: cycle._id, checklistVersionId: checklist._id,
        assessorUserId: String(e.createdBy), assessorType: 'internal', releaseState: 'n/a', evidenceIds: [], v: 0, ...result,
      }], { session: s });
      ctx = doc!.toObject() as AssessmentContext;
      await this.o.ledger.append({ actor: SYSTEM, action: 'assessment.completed', subject: { type: 'assessment', id: String(ctx._id) },
        reason: `Completed in ELEVATE (scores from ${score.source}); recorded from the completion event`, afterHash: contentHash(result) }, s);
    } else {
      const before = { status: ctx.status, scores: ctx.scores, failedQuestionKeys: ctx.failedQuestionKeys };
      const next = await AssessmentContextModel.findOneAndUpdate({ _id: ctx._id }, { $set: result, $inc: { v: 1 } }, { new: true, session: s, lean: true });
      ctx = next as AssessmentContext;
      await this.o.ledger.append({ actor: SYSTEM, action: 'assessment.completed', subject: { type: 'assessment', id: String(ctx._id) },
        reason: `Completed in ELEVATE (scores from ${score.source}): ${score.failedQuestionKeys.length} failed question(s)`,
        beforeHash: contentHash(before), afterHash: contentHash(result) }, s);
    }

    const out = await this.o.plans.draftFromCompletion({ assessment: ctx, ward, cycle, checklist, failedQuestionKeys: score.failedQuestionKeys, firstInCycle, assessorType: ctx.assessorType }, s);
    this.o.logger.info({ submission: e._id, ward: String(ward._id), outcome: out.outcome, planId: out.planId, scores: score.source }, 'assessment completion processed');
  }
}
