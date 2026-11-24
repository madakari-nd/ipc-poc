import { Problem } from '@ipc/platform';
import type { RiskLevel } from './catalogue.js';
import type { TaskStateName } from './plan.js';
import type { Role } from './scope.js';

/**
 * Task state machine (data-model §4, FR-013..FR-015). Pure: the task service loads the facts, asks
 * `decideTransition` what happens, then writes the task, the Decision, the ledger record and the
 * outbox event in one transaction. Wrong role or wrong state → 409 INVALID_TRANSITION; right role
 * but not the owner (start / submit) → 403 NOT_OWNER; open dependency → 409 DEPENDENCY_OPEN.
 */

export const DECISION_REASONS = [
  'MEETS_STANDARD', 'MEETS_STANDARD_WITH_NOTE', 'EVIDENCE_UNCLEAR', 'EVIDENCE_INCOMPLETE', 'WRONG_LOCATION_OR_ITEM',
  'STANDARD_NOT_MET', 'PATIENT_DATA_VISIBLE', 'OTHER',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];
export type DecisionKind = 'accept' | 'return' | 'validate' | 'validation_return';

export const TASK_ACTIONS = [
  'start', 'submit_evidence', 'accept', 'return', 'validate', 'validation_return', 'reassign', 'block', 'unblock', 'reopen',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** Who may ask for each action (contract x-roles; data-model §4 "Who"). */
export const ACTION_ROLES: Readonly<Record<TaskAction, readonly Role[]>> = {
  start: ['FRONTLINE', 'WARD_SUPERVISOR'],
  submit_evidence: ['FRONTLINE', 'WARD_SUPERVISOR'],
  accept: ['WARD_SUPERVISOR'],
  return: ['WARD_SUPERVISOR'],
  validate: ['IPC_OFFICER', 'DISTRICT_QM'],
  validation_return: ['IPC_OFFICER', 'DISTRICT_QM'],
  reassign: ['WARD_SUPERVISOR'],
  block: ['WARD_SUPERVISOR'],
  unblock: ['WARD_SUPERVISOR'],
  reopen: ['IPC_OFFICER'],
};

export const OPEN_STATES: readonly TaskStateName[] = ['ASSIGNED', 'IN_PROGRESS', 'EVIDENCE_SUBMITTED', 'CHANGES_REQUESTED', 'VERIFIED', 'PENDING_VALIDATION'];

export interface TaskFacts {
  state: TaskStateName;
  ownerUserId: string;
  riskLevel: RiskLevel;
  rejectionCount: number;
  blocked: boolean;
  evidenceRule: { photoRequired: boolean; minPhotos: number };
}

export interface DependencyFact { id: string; title: { en: string; hi?: string; kn?: string }; state: TaskStateName }
export interface EvidenceFact { id: string; sha256: string; mime?: string; gpsUnavailable?: boolean }

export type TaskCommand =
  | { action: 'start'; dependencies: DependencyFact[] }
  | { action: 'submit_evidence'; evidence: EvidenceFact[] }
  | { action: 'accept'; reasonCode?: string; reasonText?: string }
  | { action: 'return' | 'validate' | 'validation_return'; reasonCode: string; reasonText?: string }
  | { action: 'reassign'; newOwnerUserId: string; reason: string }
  | { action: 'block'; reason: string }
  | { action: 'unblock'; reason?: string }
  | { action: 'reopen'; reason: string };

export type TaskEventType = 'ipc.task.evidence_submitted' | 'ipc.task.decided' | 'ipc.task.validated' | 'ipc.task.assigned';

export interface TransitionOutcome {
  action: TaskAction;
  from: TaskStateName;
  /** Final state (equal to `from` for reassign, block, unblock and reopen). */
  to: TaskStateName;
  /** States entered in order; VERIFIED is a recorded pass-through (FR-013). */
  path: TaskStateName[];
  rejectionCount: number;
  ownerUserId: string;
  previousOwnerUserId?: string;
  /** undefined = unchanged, null = cleared. */
  blocked?: { reason: string } | null;
  decision?: { kind: DecisionKind; reasonCode: DecisionReason; reasonText?: string };
  event?: TaskEventType;
  ledgerAction: string;
  /** Reopen: the service creates a new linked task; this one is not changed (FR-015). */
  createsLinkedTask?: true;
}

export interface TaskActorRef { userId: string; role: Role }

/** Photos needed by an evidence rule: photo required means at least one. */
export function evidenceRuleMinimum(rule: { photoRequired: boolean; minPhotos: number }): number {
  return rule.photoRequired ? Math.max(1, rule.minPhotos) : rule.minPhotos;
}

/** Critical and high tasks need IPC officer or DQM validation after the supervisor accepts (FR-013). */
export function needsSecondValidation(risk: RiskLevel): boolean {
  return risk !== 'normal';
}

const invalid = (detail: string) => Problem.conflict('INVALID_TRANSITION', detail);

function reasonOf(code: string | undefined, required: boolean): DecisionReason | undefined {
  if (code === undefined || code === '') {
    if (required) throw Problem.unprocessable('VALIDATION_FAILED', 'Choose a reason from the list', { errors: [{ path: 'reasonCode', message: 'is required' }] });
    return undefined;
  }
  if (!(DECISION_REASONS as readonly string[]).includes(code)) {
    throw Problem.unprocessable('VALIDATION_FAILED', `Unknown reason ${code}`, { errors: [{ path: 'reasonCode', message: 'is not in the reason list' }] });
  }
  return code as DecisionReason;
}

function needState(facts: TaskFacts, allowed: readonly TaskStateName[], action: string): void {
  if (!allowed.includes(facts.state)) {
    throw invalid(facts.state === 'CLOSED' ? 'A closed task cannot change; reopen it instead' : `Cannot ${action} a task that is ${facts.state}`);
  }
}

export function decideTransition(facts: TaskFacts, cmd: TaskCommand, actor: TaskActorRef): TransitionOutcome {
  if (!ACTION_ROLES[cmd.action].includes(actor.role)) {
    throw invalid(`The ${actor.role} role cannot ${cmd.action.replace('_', ' ')} a task`);
  }
  const same = { from: facts.state, to: facts.state, path: [] as TaskStateName[], rejectionCount: facts.rejectionCount, ownerUserId: facts.ownerUserId };
  const ownerOnly = () => {
    if (actor.userId !== facts.ownerUserId) throw Problem.forbidden('NOT_OWNER', 'Only the person this task is assigned to can do this.');
  };

  switch (cmd.action) {
    case 'start': {
      needState(facts, ['ASSIGNED'], 'start');
      ownerOnly();
      const blocking = cmd.dependencies.filter((d) => d.state !== 'CLOSED');
      if (blocking.length) {
        throw Problem.conflict('DEPENDENCY_OPEN', `Finish first: ${blocking.map((b) => b.title.en).join(', ')}`, {
          blockingTasks: blocking.map((b) => ({ id: b.id, title: b.title, state: b.state })),
        });
      }
      return { ...same, action: 'start', to: 'IN_PROGRESS', path: ['IN_PROGRESS'], ledgerAction: 'task.started' };
    }
    case 'submit_evidence': {
      needState(facts, ['IN_PROGRESS', 'CHANGES_REQUESTED'], 'submit evidence for');
      ownerOnly();
      const need = evidenceRuleMinimum(facts.evidenceRule);
      const counted = facts.evidenceRule.photoRequired ? cmd.evidence.filter((e) => !e.mime || e.mime.startsWith('image/')).length : cmd.evidence.length;
      if (counted < need) {
        throw Problem.unprocessable('EVIDENCE_RULE_NOT_MET', `This task needs at least ${need} ${facts.evidenceRule.photoRequired ? 'photo(s)' : 'file(s)'} as proof`);
      }
      return { ...same, action: 'submit_evidence', to: 'EVIDENCE_SUBMITTED', path: ['EVIDENCE_SUBMITTED'], event: 'ipc.task.evidence_submitted', ledgerAction: 'task.evidence_submitted' };
    }
    case 'accept': {
      needState(facts, ['EVIDENCE_SUBMITTED'], 'accept');
      const reasonCode = reasonOf(cmd.reasonCode, false) ?? 'MEETS_STANDARD';
      const to: TaskStateName = needsSecondValidation(facts.riskLevel) ? 'PENDING_VALIDATION' : 'CLOSED';
      return {
        ...same, action: 'accept', to, path: ['VERIFIED', to], event: 'ipc.task.decided', ledgerAction: 'task.accepted',
        decision: { kind: 'accept', reasonCode, ...(cmd.reasonText ? { reasonText: cmd.reasonText } : {}) },
      };
    }
    case 'return': {
      needState(facts, ['EVIDENCE_SUBMITTED'], 'return');
      const reasonCode = reasonOf(cmd.reasonCode, true)!;
      return {
        ...same, action: 'return', to: 'CHANGES_REQUESTED', path: ['CHANGES_REQUESTED'], rejectionCount: facts.rejectionCount + 1,
        event: 'ipc.task.decided', ledgerAction: 'task.returned', decision: { kind: 'return', reasonCode, ...(cmd.reasonText ? { reasonText: cmd.reasonText } : {}) },
      };
    }
    case 'validate':
    case 'validation_return': {
      needState(facts, ['PENDING_VALIDATION'], cmd.action === 'validate' ? 'validate' : 'return');
      const reasonCode = reasonOf(cmd.reasonCode, true)!;
      const ok = cmd.action === 'validate';
      return {
        ...same, action: cmd.action, to: ok ? 'CLOSED' : 'CHANGES_REQUESTED', path: [ok ? 'CLOSED' : 'CHANGES_REQUESTED'],
        rejectionCount: ok ? facts.rejectionCount : facts.rejectionCount + 1, event: 'ipc.task.validated',
        ledgerAction: ok ? 'task.validated' : 'task.validation_returned',
        decision: { kind: cmd.action, reasonCode, ...(cmd.reasonText ? { reasonText: cmd.reasonText } : {}) },
      };
    }
    case 'reassign': {
      needState(facts, OPEN_STATES, 'reassign');
      if (!cmd.reason?.trim()) throw Problem.unprocessable('VALIDATION_FAILED', 'Give a reason for the reassignment');
      if (cmd.newOwnerUserId === facts.ownerUserId) throw Problem.unprocessable('VALIDATION_FAILED', 'The task already belongs to this person');
      return { ...same, action: 'reassign', ownerUserId: cmd.newOwnerUserId, previousOwnerUserId: facts.ownerUserId, event: 'ipc.task.assigned', ledgerAction: 'task.reassigned' };
    }
    case 'block': {
      needState(facts, OPEN_STATES, 'block');
      if (!cmd.reason?.trim()) throw Problem.unprocessable('VALIDATION_FAILED', 'Say why the task is blocked', { errors: [{ path: 'reason', message: 'is required' }] });
      if (facts.blocked) throw invalid('The task is already flagged as blocked');
      return { ...same, action: 'block', blocked: { reason: cmd.reason.trim() }, ledgerAction: 'task.blocked' };
    }
    case 'unblock': {
      needState(facts, OPEN_STATES, 'unblock');
      if (!facts.blocked) throw invalid('The task is not flagged as blocked');
      return { ...same, action: 'unblock', blocked: null, ledgerAction: 'task.unblocked' };
    }
    case 'reopen': {
      if (facts.state !== 'CLOSED') throw invalid('Only a closed task can be reopened');
      if (!cmd.reason?.trim()) throw Problem.unprocessable('VALIDATION_FAILED', 'Give a reason for reopening');
      return { ...same, action: 'reopen', createsLinkedTask: true, event: 'ipc.task.assigned', ledgerAction: 'task.reopened' };
    }
  }
}

// ------------------------------------------------------------------------- history reason format

const MAX_REASON = 500;
const STATE_RE = '(ASSIGNED|IN_PROGRESS|EVIDENCE_SUBMITTED|CHANGES_REQUESTED|VERIFIED|PENDING_VALIDATION|CLOSED)';
const TRANSITION = new RegExp(`^${STATE_RE} → ${STATE_RE}(?: · (.*))?$`, 's');
const OWNER = /^owner (\S+) → (\S+)(?: · (.*))?$/s;
const CODED = new RegExp(`^(${DECISION_REASONS.join('|')})(?:: (.*))?$`, 's');

/**
 * Ledger reason for a task change, human-readable and parseable by the history view:
 * `FROM → TO · CODE: text` or `owner A → B · text`.
 */
export function transitionReason(r: { from?: TaskStateName; to?: TaskStateName; previousOwner?: string; newOwner?: string; reasonCode?: string; text?: string }): string {
  const head = r.previousOwner !== undefined ? `owner ${r.previousOwner} → ${r.newOwner}` : `${r.from} → ${r.to}`;
  const tail = [r.reasonCode, r.text].filter(Boolean).join(': ');
  return (tail ? `${head} · ${tail}` : head).slice(0, MAX_REASON);
}

export interface ParsedReason {
  fromState?: TaskStateName; toState?: TaskStateName; reasonCode?: DecisionReason; reason?: string;
  previousOwnerUserId?: string; newOwnerUserId?: string;
}

export function parseTransitionReason(reason: string | undefined): ParsedReason {
  if (!reason) return {};
  const owner = OWNER.exec(reason);
  if (owner) return { previousOwnerUserId: owner[1], newOwnerUserId: owner[2], ...(owner[3] ? { reason: owner[3] } : {}) };
  const t = TRANSITION.exec(reason);
  if (!t) return { reason };
  const out: ParsedReason = { fromState: t[1] as TaskStateName, toState: t[2] as TaskStateName };
  if (t[3]) {
    const c = CODED.exec(t[3]);
    if (c) {
      out.reasonCode = c[1] as DecisionReason;
      if (c[2]) out.reason = c[2];
    } else out.reason = t[3];
  }
  return out;
}
