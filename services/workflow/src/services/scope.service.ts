import { Problem } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { resolveEffectiveScope, validateScopeAssignment, type ScopeAssignmentInput } from '../domain/scope.js';
import { ScopeAssignmentModel, SupportRequestModel, type ScopeAssignmentDoc } from '../domain/models/index.js';
import { withTx } from '../repositories/tx.js';
import type { LedgerService } from '../ledger/ledger.service.js';

/** Support-request states in which the chosen mentor may see the ward's facility. */
export const MENTOR_SCOPE_STATUSES = ['accepted', 'held'] as const;

/** ScopeAssignment contract shape. */
export function toScopeAssignmentDto(d: ScopeAssignmentDoc) {
  return {
    id: String(d._id),
    v: d.v,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    userId: d.userId,
    role: d.role,
    scope: { ...d.scope },
    validFrom: d.validFrom.toISOString(),
    ...(d.validTo ? { validTo: d.validTo.toISOString() } : {}),
    source: d.source,
  };
}
export type ScopeAssignmentDto = ReturnType<typeof toScopeAssignmentDto>;

export interface EffectiveScopeDto {
  userId: string;
  resolvedAt: string;
  assignments: ScopeAssignmentDto[];
  mentorFacilityIds?: string[];
}

/**
 * Scope assignments (data-model §1). The Edge resolves every request's scope through
 * `effective()` (internalGetEffectiveScope, cached 60 s there); client-sent scope is never used.
 * Validity uses real server time, not the demo clock: access control never follows a shifted clock.
 */
export class ScopeService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async effective(userId: string): Promise<EffectiveScopeDto> {
    const docs = await ScopeAssignmentModel.find({ userId }).sort({ validFrom: 1 }).lean<ScopeAssignmentDoc[]>();
    if (docs.length === 0) throw Problem.notFound('No scope assignment for this user');
    const facilityIds = (await SupportRequestModel.distinct('facilityId', {
      chosenMentorId: userId,
      status: { $in: [...MENTOR_SCOPE_STATUSES] },
    })) as unknown[];
    const r = resolveEffectiveScope({
      userId,
      assignments: docs as (ScopeAssignmentDoc & ScopeAssignmentInput)[],
      at: this.now(),
      mentorFacilityIds: facilityIds.map(String),
    });
    return {
      userId: r.userId,
      resolvedAt: r.resolvedAt.toISOString(),
      assignments: r.assignments.map(toScopeAssignmentDto),
      ...(r.mentorFacilityIds ? { mentorFacilityIds: r.mentorFacilityIds } : {}),
    };
  }

  /** Creates an assignment after the role ↔ level rule; ledger `scope.changed` in the same transaction. */
  async assign(input: ScopeAssignmentInput & { source: 'hr_import' | 'admin'; email?: string }, actor: LedgerActor, reason?: string): Promise<ScopeAssignmentDto> {
    const valid = validateScopeAssignment(input);
    return withTx(async (session) => {
      const [doc] = await ScopeAssignmentModel.create(
        [{ userId: valid.userId, role: valid.role, scope: valid.scope, validFrom: valid.validFrom, validTo: valid.validTo ?? null, source: input.source, ...(input.email ? { email: input.email } : {}) }],
        { session },
      );
      const dto = toScopeAssignmentDto(doc!.toObject() as ScopeAssignmentDoc);
      await this.ledger.append(
        { actor, action: 'scope.changed', subject: { type: 'scope_assignment', id: dto.id }, reason, afterHash: contentHash(dto) },
        session,
      );
      return dto;
    });
  }
}
