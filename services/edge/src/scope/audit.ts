import type { Request } from 'express';
import type { Logger } from '@ipc/platform';
import type { WorkflowClient } from '../workflow/workflow.client.js';
import type { ResourceKind } from './types.js';

export type DenialCode = 'SCOPE_DENIED' | 'NOT_OWNER' | 'ROLE_DENIED' | 'CSRF_INVALID';

const SUBJECT_TYPE: Record<ResourceKind, string> = {
  evidence: 'evidence',
  task: 'task',
  plan: 'plan',
  assessment: 'assessment',
  support_request: 'support_request',
};

const ACTION: Record<DenialCode, string> = {
  SCOPE_DENIED: 'scope.denied',
  NOT_OWNER: 'owner.denied',
  ROLE_DENIED: 'role.denied',
  CSRF_INVALID: 'csrf.denied',
};

/**
 * Writes programme actions and every 403 to the workflow ledger (`internalAppendLedger`).
 * A ledger outage never turns a denial into an allow; it is logged as an error instead.
 */
export class Auditor {
  constructor(
    private readonly workflow: WorkflowClient,
    private readonly logger: Logger,
  ) {}

  private actor(req: Request) {
    const userId = req.scope?.userId ?? req.session?.userId ?? 'anonymous';
    const role = req.scope?.activeRole ?? 'SYSTEM';
    return { userId: userId.slice(0, 64), role };
  }

  private correlationId(req: Request): string {
    return String(req.res?.locals.correlationId ?? 'none').slice(0, 64);
  }

  async denial(req: Request, code: DenialCode, subject?: { kind: ResourceKind; id: string }): Promise<void> {
    const action = code === 'SCOPE_DENIED' && subject?.kind === 'evidence' ? 'evidence.denied' : ACTION[code];
    await this.record(req, action, subject ? { type: SUBJECT_TYPE[subject.kind], id: subject.id } : undefined);
  }

  async record(
    req: Request,
    action: string,
    subject?: { type: string; id: string },
    extra: { reason?: string; beforeHash?: string; afterHash?: string } = {},
  ): Promise<void> {
    const entry = {
      actor: this.actor(req),
      action,
      // Denials of whole operations have no resource; the operation id is the subject.
      subject: subject ?? { type: 'programme', id: (req.operation?.operationId ?? req.path).slice(0, 64) },
      correlationId: this.correlationId(req),
      ...extra,
    };
    try {
      await this.workflow.appendLedger(entry);
    } catch (err) {
      this.logger.error({ err, action, subject: entry.subject }, 'ledger append failed');
    }
  }
}
