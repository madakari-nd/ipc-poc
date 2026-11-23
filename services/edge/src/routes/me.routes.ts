import { Router } from 'express';
import { Problem } from '@ipc/platform';
import type { SessionDoc } from '../db/models.js';
import type { CallerScope, Role } from '../scope/types.js';
import type { WorkflowClient } from '../workflow/workflow.client.js';

export interface MeContext {
  demoMode: boolean;
  profile: string;
}

/** Contract `Me`: identity, server-derived assignments, active role and the CSRF token. */
export function buildMe(session: SessionDoc, scope: CallerScope, ctx: MeContext) {
  if (!scope.activeRole) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role. Contact your administrator.');
  return {
    userId: session.userId,
    name: session.name,
    activeRole: scope.activeRole,
    assignments: scope.assignments,
    preferredLanguage: session.preferredLanguage,
    csrfToken: session.csrfToken,
    sessionExpiresAt: session.expiresAt.toISOString(),
    demoMode: ctx.demoMode,
    profile: ctx.profile,
  };
}

/** Cards each role may act on (FR-036, Constitution VIII: a user never sees an action they cannot take). */
export const HOME_CARDS: Record<Role, readonly string[]> = {
  STATE_ADMIN: ['checklist_drafts', 'import_jobs', 'escalations', 'overdue_critical', 'data_quality_exceptions', 'unread_notifications'],
  DISTRICT_QM: ['held_results', 'validation_queue', 'escalations', 'overdue_critical', 'support_requests', 'data_quality_exceptions', 'unread_notifications'],
  IPC_OFFICER: [
    'assessments_due',
    'draft_plans',
    'validation_queue',
    'overdue_critical',
    'escalations',
    'support_requests',
    'stale_devices',
    'data_quality_exceptions',
    'unread_notifications',
  ],
  WARD_SUPERVISOR: ['review_queue', 'needs_reassignment', 'my_tasks', 'overdue_critical', 'escalations', 'stale_devices', 'data_quality_exceptions', 'unread_notifications'],
  FRONTLINE: ['my_tasks', 'unread_notifications'],
  MENTOR: ['support_requests', 'unread_notifications'],
  EXTERNAL_AUDITOR: ['assessments_due', 'unread_notifications'],
};

/** T045: `GET /me` (getMe) and `GET /me/home` (getHome, aggregated from workflow, filtered per role). */
export function meRoutes(workflow: WorkflowClient, ctx: MeContext): Router {
  const r = Router();
  r.get('/me', (req, res) => {
    res.json(buildMe(req.session!, req.scope!, ctx));
  });
  r.get('/me/home', async (req, res) => {
    const role = req.scope!.activeRole!;
    const home = await workflow.getHome({ userId: req.scope!.userId, role });
    const allowed = new Set(HOME_CARDS[role]);
    res.json({
      role,
      programmeNow: home.programmeNow,
      cards: home.cards.filter((c) => allowed.has(c.kind)),
    });
  });
  return r;
}
