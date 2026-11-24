/**
 * T097 (US5, FR-020): escalation rules are pure. R1 "critical overdue ≥ 48 h → IPC officer" and
 * R2 "critical overdue ≥ 7 days → district quality manager" fire from the sweep; R3 "returned 2
 * times → the level above whoever returned it" fires from the on-return hook; each is idempotent
 * on (task, ruleCode, level); a vacant target escalates to the next level up and is flagged; a
 * supervisor's manual escalation targets the IPC officer; escalations never change the task owner.
 */
import { describe, expect, it } from 'vitest';
import { ROLE_LEVEL, levelAbove, evaluateOverdue, evaluateRejections, escalateTarget, type EscalationRuleLike, type TaskFacts } from '../../src/domain/escalation.js';

const HOUR = 3_600_000;

const baseTask = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  id: 't1', state: 'IN_PROGRESS', riskLevel: 'critical', dueAt: new Date('2026-11-01T00:00:00Z'), rejectionCount: 0, ...over,
});

const r1 = (over: Partial<EscalationRuleLike> = {}): EscalationRuleLike => ({
  code: 'R1', active: true, condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 48 },
  target: { mode: 'role', role: 'IPC_OFFICER' }, channels: ['inapp', 'email'], ...over,
});

const r2 = (over: Partial<EscalationRuleLike> = {}): EscalationRuleLike => ({
  code: 'R2', active: true, condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 168 },
  target: { mode: 'role', role: 'DISTRICT_QM' }, channels: ['inapp', 'email'], ...over,
});

const r3 = (over: Partial<EscalationRuleLike> = {}): EscalationRuleLike => ({
  code: 'R3', active: true, condition: { type: 'rejections', riskLevels: ['critical', 'high', 'normal'], thresholdCount: 2 },
  target: { mode: 'level_above_decider' }, channels: ['inapp', 'email'], ...over,
});

const now = (h: number) => new Date('2026-11-01T00:00:00Z').getTime() + h * HOUR;

describe('ROLE_LEVEL and levelAbove (data-model §5)', () => {
  it('levels follow the escalation chain supervisor → officer → district → state', () => {
    expect(ROLE_LEVEL.WARD_SUPERVISOR).toBe(1);
    expect(ROLE_LEVEL.IPC_OFFICER).toBe(2);
    expect(ROLE_LEVEL.DISTRICT_QM).toBe(3);
    expect(ROLE_LEVEL.STATE_ADMIN).toBe(4);
  });

  it('levelAbove climbs one rung, and the top has no level above', () => {
    expect(levelAbove('WARD_SUPERVISOR')).toBe('IPC_OFFICER');
    expect(levelAbove('IPC_OFFICER')).toBe('DISTRICT_QM');
    expect(levelAbove('DISTRICT_QM')).toBe('STATE_ADMIN');
    expect(levelAbove('STATE_ADMIN')).toBeUndefined();
  });

  it('roles outside the chain have level 0 and no level above', () => {
    expect(ROLE_LEVEL.FRONTLINE).toBe(0);
    expect(levelAbove('FRONTLINE')).toBeUndefined();
    expect(levelAbove('MENTOR')).toBeUndefined();
  });
});

describe('R1/R2 overdue rules (proposal A11)', () => {
  it('R1 fires for a critical task overdue by ≥ 48 h, targeting the IPC officer', () => {
    const out = escalateTarget(r1(), baseTask(), now(49), undefined);
    expect(out).toEqual({ ruleCode: 'R1', level: 2, targetRole: 'IPC_OFFICER', channels: ['inapp', 'email'] });
  });

  it('R1 does not fire before 48 h have passed', () => {
    expect(escalateTarget(r1(), baseTask(), now(47), undefined)).toBeNull();
  });

  it('R1 does not fire for a non-critical task, even when overdue', () => {
    expect(escalateTarget(r1(), baseTask({ riskLevel: 'high' }), now(100), undefined)).toBeNull();
  });

  it('R2 fires at ≥ 7 days (168 h), targeting the district quality manager', () => {
    const out = escalateTarget(r2(), baseTask(), now(169), undefined);
    expect(out).toEqual({ ruleCode: 'R2', level: 3, targetRole: 'DISTRICT_QM', channels: ['inapp', 'email'] });
    expect(escalateTarget(r2(), baseTask(), now(167), undefined)).toBeNull();
  });

  it('a closed task is never overdue-escalated', () => {
    expect(escalateTarget(r1(), baseTask({ state: 'CLOSED' }), now(200), undefined)).toBeNull();
  });

  it('an inactive rule never fires', () => {
    expect(escalateTarget(r1({ active: false }), baseTask(), now(100), undefined)).toBeNull();
  });
});

describe('R3 repeated-rejection rule (returned 2 times → level above the decider)', () => {
  it('fires on the second rejection, one level above the role that returned it', () => {
    const out = escalateTarget(r3(), baseTask({ rejectionCount: 2 }), now(1), 'WARD_SUPERVISOR');
    expect(out).toEqual({ ruleCode: 'R3', level: 2, targetRole: 'IPC_OFFICER', channels: ['inapp', 'email'] });
  });

  it('a validation return by the IPC officer escalates to the district quality manager', () => {
    const out = escalateTarget(r3(), baseTask({ rejectionCount: 3 }), now(1), 'IPC_OFFICER');
    expect(out).toEqual({ ruleCode: 'R3', level: 3, targetRole: 'DISTRICT_QM', channels: ['inapp', 'email'] });
  });

  it('does not fire below the threshold', () => {
    expect(escalateTarget(r3(), baseTask({ rejectionCount: 1 }), now(1), 'WARD_SUPERVISOR')).toBeNull();
  });

  it('a district quality manager returning a task escalates to the state administrator', () => {
    const out = escalateTarget(r3(), baseTask({ rejectionCount: 2 }), now(1), 'DISTRICT_QM');
    expect(out).toEqual({ ruleCode: 'R3', level: 4, targetRole: 'STATE_ADMIN', channels: ['inapp', 'email'] });
  });

  it('a state administrator returning has no level above, so nothing fires', () => {
    expect(escalateTarget(r3(), baseTask({ rejectionCount: 2 }), now(1), 'STATE_ADMIN')).toBeNull();
  });
});

describe('evaluateOverdue and evaluateRejections helpers', () => {
  it('evaluateOverdue compares programmeNow against dueAt plus the threshold', () => {
    expect(evaluateOverdue(baseTask(), r1().condition, now(48))).toBe(true);
    expect(evaluateOverdue(baseTask(), r1().condition, now(48 - 1))).toBe(false);
  });

  it('evaluateRejections compares the task rejection count with the threshold', () => {
    expect(evaluateRejections(baseTask({ rejectionCount: 2 }), r3().condition)).toBe(true);
    expect(evaluateRejections(baseTask({ rejectionCount: 1 }), r3().condition)).toBe(false);
  });
});
