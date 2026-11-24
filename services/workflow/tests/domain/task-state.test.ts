/**
 * T090 (US4, FR-013..FR-016): the task state machine is pure. Every transition of the data-model §4
 * table, only by the listed role; a wrong role is INVALID_TRANSITION, an open dependency is
 * DEPENDENCY_OPEN naming the blocking task, each return increments the rejection count, reassign and
 * block leave the state unchanged, and reopen creates a new linked task (the closed one is untouched).
 */
import { describe, expect, it } from 'vitest';
import { Problem } from '@ipc/platform';
import {
  decideTransition, evidenceRuleMinimum, needsSecondValidation, parseTransitionReason, transitionReason,
  type TaskCommand, type TaskFacts,
} from '../../src/domain/task.js';
import type { TaskStateName } from '../../src/domain/plan.js';
import type { Role } from '../../src/domain/scope.js';

const OWNER = 'u-owner';
const base = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  state: 'ASSIGNED', ownerUserId: OWNER, riskLevel: 'critical', rejectionCount: 0, blocked: false,
  evidenceRule: { photoRequired: true, minPhotos: 1 }, ...over,
});
const owner = (role: Role = 'FRONTLINE') => ({ userId: OWNER, role });
const sup = { userId: 'u-sup', role: 'WARD_SUPERVISOR' as Role };
const officer = { userId: 'u-off', role: 'IPC_OFFICER' as Role };
const dqm = { userId: 'u-dqm', role: 'DISTRICT_QM' as Role };
const photo = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, sha256: String(i).repeat(64).slice(0, 64), mime: 'image/jpeg' }));

function fails(fn: () => unknown, code: string, status?: number): Problem {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Problem);
    expect((e as Problem).code).toBe(code);
    if (status) expect((e as Problem).status).toBe(status);
    return e as Problem;
  }
  throw new Error(`expected ${code}`);
}

describe('task state machine: the data-model §4 table', () => {
  it('owner starts an ASSIGNED task when every dependency is closed', () => {
    const o = decideTransition(base(), { action: 'start', dependencies: [{ id: 'd1', title: { en: 'Dep' }, state: 'CLOSED' }] }, owner());
    expect(o).toMatchObject({ from: 'ASSIGNED', to: 'IN_PROGRESS', path: ['IN_PROGRESS'], ledgerAction: 'task.started', rejectionCount: 0 });
    expect(o.event).toBeUndefined();
  });

  it('a ward supervisor who owns the task may start and submit it too (contract x-roles)', () => {
    expect(decideTransition(base(), { action: 'start', dependencies: [] }, owner('WARD_SUPERVISOR')).to).toBe('IN_PROGRESS');
  });

  it.each<TaskStateName>(['IN_PROGRESS', 'CHANGES_REQUESTED'])('owner submits evidence from %s → EVIDENCE_SUBMITTED', (state) => {
    const o = decideTransition(base({ state }), { action: 'submit_evidence', evidence: photo(1) }, owner());
    expect(o).toMatchObject({ from: state, to: 'EVIDENCE_SUBMITTED', event: 'ipc.task.evidence_submitted', ledgerAction: 'task.evidence_submitted' });
  });

  it('supervisor accepts a normal task: VERIFIED is recorded, then CLOSED without second validation', () => {
    const o = decideTransition(base({ state: 'EVIDENCE_SUBMITTED', riskLevel: 'normal' }), { action: 'accept' }, sup);
    expect(o).toMatchObject({ to: 'CLOSED', path: ['VERIFIED', 'CLOSED'], decision: { kind: 'accept', reasonCode: 'MEETS_STANDARD' }, event: 'ipc.task.decided' });
  });

  it.each(['critical', 'high'] as const)('supervisor accepts a %s task → VERIFIED → PENDING_VALIDATION', (riskLevel) => {
    const o = decideTransition(base({ state: 'EVIDENCE_SUBMITTED', riskLevel }), { action: 'accept', reasonCode: 'MEETS_STANDARD_WITH_NOTE', reasonText: 'ok' }, sup);
    expect(o).toMatchObject({ to: 'PENDING_VALIDATION', path: ['VERIFIED', 'PENDING_VALIDATION'], decision: { kind: 'accept', reasonCode: 'MEETS_STANDARD_WITH_NOTE', reasonText: 'ok' } });
  });

  it('supervisor returns with a reason → CHANGES_REQUESTED, rejection count + 1', () => {
    const o = decideTransition(base({ state: 'EVIDENCE_SUBMITTED', rejectionCount: 2 }), { action: 'return', reasonCode: 'EVIDENCE_UNCLEAR' }, sup);
    expect(o).toMatchObject({ to: 'CHANGES_REQUESTED', rejectionCount: 3, decision: { kind: 'return', reasonCode: 'EVIDENCE_UNCLEAR' }, event: 'ipc.task.decided', ledgerAction: 'task.returned' });
  });

  it.each([officer, dqm])('$role validates → CLOSED', (actor) => {
    const o = decideTransition(base({ state: 'PENDING_VALIDATION' }), { action: 'validate', reasonCode: 'MEETS_STANDARD' }, actor);
    expect(o).toMatchObject({ to: 'CLOSED', decision: { kind: 'validate' }, event: 'ipc.task.validated', ledgerAction: 'task.validated', rejectionCount: 0 });
  });

  it.each([officer, dqm])('$role returns from validation → CHANGES_REQUESTED, rejection count + 1', (actor) => {
    const o = decideTransition(base({ state: 'PENDING_VALIDATION', rejectionCount: 1 }), { action: 'validation_return', reasonCode: 'STANDARD_NOT_MET', reasonText: 'retake' }, actor);
    expect(o).toMatchObject({ to: 'CHANGES_REQUESTED', rejectionCount: 2, decision: { kind: 'validation_return', reasonText: 'retake' }, event: 'ipc.task.validated' });
  });

  it('IPC officer reopens a CLOSED task: a new linked task, the closed task unchanged', () => {
    const o = decideTransition(base({ state: 'CLOSED' }), { action: 'reopen', reason: 'Dispenser removed again' }, officer);
    expect(o).toMatchObject({ from: 'CLOSED', to: 'CLOSED', path: [], createsLinkedTask: true, ledgerAction: 'task.reopened', event: 'ipc.task.assigned' });
  });
});

describe('only the listed role moves a task (wrong role → INVALID_TRANSITION)', () => {
  const cases: [string, TaskFacts, TaskCommand, { userId: string; role: Role }][] = [
    ['supervisor cannot start', base(), { action: 'start', dependencies: [] }, { userId: OWNER, role: 'IPC_OFFICER' }],
    ['officer cannot submit evidence', base({ state: 'IN_PROGRESS' }), { action: 'submit_evidence', evidence: photo(1) }, { userId: OWNER, role: 'IPC_OFFICER' }],
    ['frontline cannot accept', base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'accept' }, owner()],
    ['officer cannot accept (supervisor decides)', base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'accept' }, officer],
    ['DQM cannot return evidence', base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'return', reasonCode: 'OTHER' }, dqm],
    ['supervisor cannot validate', base({ state: 'PENDING_VALIDATION' }), { action: 'validate', reasonCode: 'MEETS_STANDARD' }, sup],
    ['frontline cannot validation-return', base({ state: 'PENDING_VALIDATION' }), { action: 'validation_return', reasonCode: 'OTHER' }, owner()],
    ['officer cannot reassign', base(), { action: 'reassign', newOwnerUserId: 'x', reason: 'r' }, officer],
    ['frontline cannot block', base(), { action: 'block', reason: 'r' }, owner()],
    ['supervisor cannot reopen', base({ state: 'CLOSED' }), { action: 'reopen', reason: 'r' }, sup],
  ];
  it.each(cases)('%s', (_name, facts, cmd, actor) => {
    fails(() => decideTransition(facts, cmd, actor), 'INVALID_TRANSITION', 409);
  });

  it('the right role in the wrong state is INVALID_TRANSITION too', () => {
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'start', dependencies: [] }, owner()), 'INVALID_TRANSITION');
    fails(() => decideTransition(base({ state: 'ASSIGNED' }), { action: 'submit_evidence', evidence: photo(1) }, owner()), 'INVALID_TRANSITION');
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'accept' }, sup), 'INVALID_TRANSITION');
    fails(() => decideTransition(base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'validate', reasonCode: 'MEETS_STANDARD' }, officer), 'INVALID_TRANSITION');
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'reopen', reason: 'r' }, officer), 'INVALID_TRANSITION');
  });

  it('a closed task never changes (FR-015): no start, submit, reassign or block', () => {
    const closed = base({ state: 'CLOSED' });
    fails(() => decideTransition(closed, { action: 'reassign', newOwnerUserId: 'x', reason: 'r' }, sup), 'INVALID_TRANSITION');
    fails(() => decideTransition(closed, { action: 'block', reason: 'r' }, sup), 'INVALID_TRANSITION');
    fails(() => decideTransition(closed, { action: 'submit_evidence', evidence: photo(1) }, owner()), 'INVALID_TRANSITION');
  });

  it('the right role but not the owner is 403 NOT_OWNER (start and submit)', () => {
    fails(() => decideTransition(base(), { action: 'start', dependencies: [] }, { userId: 'someone', role: 'FRONTLINE' }), 'NOT_OWNER', 403);
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'submit_evidence', evidence: photo(1) }, { userId: 'someone', role: 'FRONTLINE' }), 'NOT_OWNER', 403);
  });
});

describe('dependencies, evidence rule and reasons', () => {
  it('an open dependency refuses the start with DEPENDENCY_OPEN naming the blocking task', () => {
    const p = fails(() => decideTransition(base(), {
      action: 'start',
      dependencies: [{ id: 'd1', title: { en: 'Closed one' }, state: 'CLOSED' }, { id: 'd2', title: { en: 'Fit dispensers' }, state: 'IN_PROGRESS' }],
    }, owner()), 'DEPENDENCY_OPEN', 409);
    expect(p.extensions).toMatchObject({ blockingTasks: [{ id: 'd2', title: { en: 'Fit dispensers' }, state: 'IN_PROGRESS' }] });
    expect(p.detail).toContain('Fit dispensers');
  });

  it('evidence must meet the rule (EVIDENCE_RULE_NOT_MET): photo required counts photos only', () => {
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'submit_evidence', evidence: [] }, owner()), 'EVIDENCE_RULE_NOT_MET', 422);
    fails(() => decideTransition(base({ state: 'IN_PROGRESS', evidenceRule: { photoRequired: true, minPhotos: 2 } }), { action: 'submit_evidence', evidence: photo(1) }, owner()), 'EVIDENCE_RULE_NOT_MET');
    fails(() => decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'submit_evidence', evidence: [{ id: 'p', sha256: 'a'.repeat(64), mime: 'application/pdf' }] }, owner()), 'EVIDENCE_RULE_NOT_MET');
    expect(decideTransition(base({ state: 'IN_PROGRESS', evidenceRule: { photoRequired: false, minPhotos: 0 } }), { action: 'submit_evidence', evidence: [] }, owner()).to).toBe('EVIDENCE_SUBMITTED');
  });

  it('the evidence minimum: photo required means at least one photo', () => {
    expect(evidenceRuleMinimum({ photoRequired: true, minPhotos: 0 })).toBe(1);
    expect(evidenceRuleMinimum({ photoRequired: true, minPhotos: 3 })).toBe(3);
    expect(evidenceRuleMinimum({ photoRequired: false, minPhotos: 0 })).toBe(0);
  });

  it('returns and validations need a reason from the list (FR-014); accept defaults to MEETS_STANDARD', () => {
    fails(() => decideTransition(base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'return' } as TaskCommand, sup), 'VALIDATION_FAILED', 422);
    fails(() => decideTransition(base({ state: 'EVIDENCE_SUBMITTED' }), { action: 'return', reasonCode: 'NOT_A_CODE' }, sup), 'VALIDATION_FAILED');
    fails(() => decideTransition(base({ state: 'PENDING_VALIDATION' }), { action: 'validate' } as TaskCommand, officer), 'VALIDATION_FAILED');
  });

  it('second validation is for critical and high tasks', () => {
    expect(needsSecondValidation('critical')).toBe(true);
    expect(needsSecondValidation('high')).toBe(true);
    expect(needsSecondValidation('normal')).toBe(false);
  });
});

describe('reassign and block leave the state unchanged', () => {
  it.each<TaskStateName>(['ASSIGNED', 'IN_PROGRESS', 'EVIDENCE_SUBMITTED', 'CHANGES_REQUESTED', 'PENDING_VALIDATION'])('reassign in %s keeps the state, changes the owner', (state) => {
    const o = decideTransition(base({ state, rejectionCount: 1 }), { action: 'reassign', newOwnerUserId: 'u-new', reason: 'On leave' }, sup);
    expect(o).toMatchObject({ from: state, to: state, path: [], ownerUserId: 'u-new', previousOwnerUserId: OWNER, rejectionCount: 1, event: 'ipc.task.assigned', ledgerAction: 'task.reassigned' });
  });

  it('reassigning to the same owner is refused', () => {
    fails(() => decideTransition(base(), { action: 'reassign', newOwnerUserId: OWNER, reason: 'x' }, sup), 'VALIDATION_FAILED');
  });

  it('block sets the flag with a reason; unblock clears it; neither changes the state', () => {
    const b = decideTransition(base({ state: 'IN_PROGRESS' }), { action: 'block', reason: 'Waiting for supplies' }, sup);
    expect(b).toMatchObject({ to: 'IN_PROGRESS', blocked: { reason: 'Waiting for supplies' }, ledgerAction: 'task.blocked' });
    const u = decideTransition(base({ state: 'IN_PROGRESS', blocked: true }), { action: 'unblock' }, sup);
    expect(u).toMatchObject({ to: 'IN_PROGRESS', blocked: null, ledgerAction: 'task.unblocked' });
    fails(() => decideTransition(base(), { action: 'block', reason: '' }, sup), 'VALIDATION_FAILED');
    fails(() => decideTransition(base({ blocked: true }), { action: 'block', reason: 'again' }, sup), 'INVALID_TRANSITION');
    fails(() => decideTransition(base(), { action: 'unblock' }, sup), 'INVALID_TRANSITION');
  });
});

describe('history reasons are structured and parseable', () => {
  it('round-trips state changes, reason codes and owner changes', () => {
    const r = transitionReason({ from: 'EVIDENCE_SUBMITTED', to: 'CHANGES_REQUESTED', reasonCode: 'EVIDENCE_UNCLEAR', text: 'Blurred photo' });
    expect(r).toBe('EVIDENCE_SUBMITTED → CHANGES_REQUESTED · EVIDENCE_UNCLEAR: Blurred photo');
    expect(parseTransitionReason(r)).toEqual({ fromState: 'EVIDENCE_SUBMITTED', toState: 'CHANGES_REQUESTED', reasonCode: 'EVIDENCE_UNCLEAR', reason: 'Blurred photo' });
    const o = transitionReason({ previousOwner: 'a', newOwner: 'b', text: 'On leave' });
    expect(parseTransitionReason(o)).toEqual({ previousOwnerUserId: 'a', newOwnerUserId: 'b', reason: 'On leave' });
    expect(parseTransitionReason('initial: owner 66, due 2026-12-01')).toEqual({ reason: 'initial: owner 66, due 2026-12-01' });
    expect(parseTransitionReason(undefined)).toEqual({});
    expect(transitionReason({ from: 'ASSIGNED', to: 'IN_PROGRESS' })).toBe('ASSIGNED → IN_PROGRESS');
    expect(transitionReason({ from: 'IN_PROGRESS', to: 'EVIDENCE_SUBMITTED', text: 'x'.repeat(600) }).length).toBeLessThanOrEqual(500);
  });
});
