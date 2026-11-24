import type { Role } from './scope.js';

/**
 * Escalation rules (US5, FR-020, proposal A11). Pure: the escalation service loads the facts, asks
 * these functions what to escalate, then writes the Escalation, its notifications, the ledger record
 * and the `ipc.task.escalated` outbox event in one transaction. Escalation never changes the task
 * owner, state or history (the Escalation is a separate record referencing the task).
 *
 * Level chain (data-model §5, spec "next level"): ward supervisor (1) → IPC officer (2) → district
 * quality manager (3) → state administrator (4). "Level above the decider" (R3) uses the role that
 * returned the task; a vacant target role escalates to the next level up and is flagged.
 */

export const HOUR_MS = 3_600_000;

/** Fixed level of each escalation-chain role; 0 = not on the chain. */
export const ROLE_LEVEL: Readonly<Record<Role, number>> = {
  WARD_SUPERVISOR: 1,
  IPC_OFFICER: 2,
  DISTRICT_QM: 3,
  STATE_ADMIN: 4,
  FRONTLINE: 0,
  MENTOR: 0,
  EXTERNAL_AUDITOR: 0,
};

/** One rung up the escalation chain; undefined at the top. */
export function levelAbove(role: Role): Role | undefined {
  const l = ROLE_LEVEL[role];
  if (l < 1 || l >= 4) return undefined;
  return l === 1 ? 'IPC_OFFICER' : l === 2 ? 'DISTRICT_QM' : 'STATE_ADMIN';
}

/** Facts of a task the rules read. */
export interface TaskFacts {
  id: string;
  state: string;
  riskLevel: 'critical' | 'high' | 'normal';
  dueAt: Date;
  rejectionCount: number;
}

/** A configured escalation rule (model + admin service). */
export interface EscalationRuleLike {
  code: string;
  active: boolean;
  condition: { type: 'overdue' | 'rejections'; riskLevels: TaskFacts['riskLevel'][]; thresholdHours?: number; thresholdCount?: number };
  target: { mode: 'role' | 'level_above_decider'; role?: string };
  channels: ('inapp' | 'email' | 'sms')[];
}

/** What a rule would produce, given the task and the programme clock. */
export interface EscalationTarget {
  ruleCode: string;
  level: number;
  targetRole: Role;
  channels: EscalationRuleLike['channels'];
}

/** Does `now` sit past `dueAt + thresholdHours`? */
export function evaluateOverdue(t: TaskFacts, c: EscalationRuleLike['condition'], nowMs: number): boolean {
  if (t.state === 'CLOSED') return false;
  if (!c.thresholdHours) return false;
  return nowMs - t.dueAt.getTime() >= c.thresholdHours * HOUR_MS;
}

/** Has the task been rejected at least `thresholdCount` times? */
export function evaluateRejections(t: TaskFacts, c: EscalationRuleLike['condition']): boolean {
  if (!c.thresholdCount) return false;
  return t.rejectionCount >= c.thresholdCount;
}

/**
 * Decides whether an active rule fires for a task at programme time `nowMs`. `deciderRole` is the
 * role that returned the task (required by `level_above_decider` targets, i.e. R3). Returns null
 * when the rule is inactive, the risk level is not covered, the condition is not met, the target is
 * a role without a level, or there is no level above the decider.
 */
export function escalateTarget(
  rule: EscalationRuleLike,
  t: TaskFacts,
  nowMs: number,
  deciderRole: Role | undefined,
): EscalationTarget | null {
  if (!rule.active) return null;
  if (!rule.condition.riskLevels.includes(t.riskLevel)) return null;

  if (rule.condition.type === 'overdue') {
    if (!evaluateOverdue(t, rule.condition, nowMs)) return null;
    if (rule.target.mode !== 'role' || !rule.target.role) return null;
    const targetRole = rule.target.role as Role;
    const level = ROLE_LEVEL[targetRole];
    if (level < 1) return null;
    return { ruleCode: rule.code, level, targetRole, channels: rule.channels };
  }

  // rejections
  if (!evaluateRejections(t, rule.condition)) return null;
  if (rule.target.mode !== 'level_above_decider') return null;
  const targetRole = levelAbove(deciderRole ?? 'FRONTLINE');
  if (!targetRole) return null;
  return { ruleCode: rule.code, level: ROLE_LEVEL[targetRole], targetRole, channels: rule.channels };
}

/** The unique identity an escalation record carries (idempotent on task + rule + level). */
export function escalationKey(ruleCode: string, level: number): string {
  return `${ruleCode}:${level}`;
}
