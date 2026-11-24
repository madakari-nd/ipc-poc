import { Problem } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import { releaseRefusal } from '../domain/comparison.js';
import { AssessmentContextModel, ChecklistVersionModel, type AssessmentContext } from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import type { ActorScope } from './admin.service.js';
import { toAssessmentDto, type AssessmentService } from './assessment.service.js';
import type { Outbox } from './outbox.publisher.js';

type Actor = { userId: string } & ActorScope;

/**
 * `releaseAssessment` (US7, FR-024a, T111): a held external-auditor result becomes visible to the
 * hospital only when the district quality manager releases it. The state change, the ledger record
 * `assessment.released` and the `ipc.assessment.released` event are written in ONE transaction.
 */
export class ReleaseService {
  constructor(
    private readonly d: { assessment: AssessmentService; ledger: LedgerService; outbox: Outbox; programmeNow: () => Date },
  ) {}

  async release(id: string, body: { note?: string }, ifMatch: number | undefined, actor: Actor) {
    const a = await this.d.assessment.findVisible(id, actor);
    const version = (await ChecklistVersionModel.findById(a.checklistVersionId, { version: 1 }).lean<{ version: number }>())?.version ?? 1;
    const current = toAssessmentDto(a, version);
    const refusal = releaseRefusal(a, actor.role);
    if (refusal?.status === 403) throw Problem.forbidden(refusal.code, refusal.detail);
    if (refusal) throw Problem.conflict(refusal.code, refusal.detail, { current });
    if (ifMatch !== undefined && ifMatch !== a.v) {
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this assessment since you opened it', { currentVersion: a.v, current });
    }
    const now = this.d.programmeNow();
    return withTx(async (s) => {
      const next = await AssessmentContextModel.findOneAndUpdate(
        { _id: a._id, v: a.v, releaseState: 'held' },
        { $set: { releaseState: 'released', releasedBy: actor.userId, releasedAt: now }, $inc: { v: 1 } },
        { new: true, session: s, lean: true },
      );
      if (!next) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this assessment since you opened it', { currentVersion: a.v, current });
      const dto = toAssessmentDto(next as AssessmentContext, version);
      const subject = { type: 'assessment' as const, id: String(a._id) };
      const by = { userId: actor.userId, role: actor.role };
      await this.d.ledger.append(
        { actor: by, action: 'assessment.released', subject, ...(body.note ? { reason: body.note } : {}), beforeHash: contentHash(current), afterHash: contentHash(dto) },
        s,
      );
      await this.d.outbox.enqueue(
        {
          type: 'ipc.assessment.released',
          key: String(a.wardId),
          actor: by,
          subject,
          payload: {
            assessmentId: String(a._id),
            wardId: String(a.wardId),
            facilityId: String(a.facilityId),
            cycleId: String(a.cycleId),
            checklistVersionId: String(a.checklistVersionId),
            checklistVersion: version,
            assessorType: 'external',
            baselineOfId: a.baselineOfId ? String(a.baselineOfId) : null,
            scoreTotal: a.scores?.total ?? 0,
            ...(dto.scores?.bySection ? { scoreBySection: dto.scores.bySection } : {}),
            completedAt: (a.completedAt ?? now).toISOString(),
            releasedBy: actor.userId,
            releasedAt: now.toISOString(),
          },
        },
        s,
      );
      return dto;
    });
  }
}
