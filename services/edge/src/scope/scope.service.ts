import type { WorkflowClient } from '../workflow/workflow.client.js';
import { ROLES, type CallerScope, type EffectiveScopeResponse, type Role, type ScopeAssignment } from './types.js';

const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);

/** Assignments valid at `now` (validFrom ≤ now < validTo). */
export function activeAssignments(resp: EffectiveScopeResponse, now: number): ScopeAssignment[] {
  return resp.assignments.filter((a) => {
    if (!isRole(a.role)) return false;
    if (Date.parse(a.validFrom) > now) return false;
    return !a.validTo || Date.parse(a.validTo) > now;
  });
}

/** Resolves each user's effective scope from workflow, cached 60 s (T039). */
export class ScopeService {
  private readonly cache = new Map<string, { at: number; value: EffectiveScopeResponse }>();

  constructor(
    private readonly workflow: WorkflowClient,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(userId: string, preferredRole?: string): Promise<CallerScope> {
    const t = this.now();
    let hit = this.cache.get(userId);
    if (!hit || t - hit.at >= this.ttlMs) {
      hit = { at: t, value: await this.workflow.getEffectiveScope(userId) };
      this.cache.set(userId, hit);
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value as string);
    }
    const assignments = activeAssignments(hit.value, t);
    const roles = [...new Set(assignments.map((a) => a.role))];
    const activeRole = roles.find((r) => r === preferredRole) ?? roles[0] ?? null;
    return {
      userId,
      activeRole,
      roles,
      assignments,
      mentorFacilityIds: hit.value.mentorFacilityIds ?? [],
      resolvedAt: hit.value.resolvedAt,
    };
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
