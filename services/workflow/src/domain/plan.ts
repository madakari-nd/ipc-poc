import { randomUUID } from 'node:crypto';
import { Problem } from '@ipc/platform';
import type { AssessorType } from './assessment.js';
import { rootExternalId, type RiskLevel } from './catalogue.js';

/**
 * Improvement plan rules (FR-011, FR-012, FR-017, FR-018, FR-019; data-model §4; research E8, E9).
 * Pure functions: the plan service, the observation consumer and the reconcile job do the I/O.
 */

export const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { critical: 3, high: 2, normal: 1 };
const DAY_MS = 86_400_000;

export type TaskStateName =
  | 'ASSIGNED' | 'IN_PROGRESS' | 'EVIDENCE_SUBMITTED' | 'CHANGES_REQUESTED' | 'VERIFIED' | 'PENDING_VALIDATION' | 'CLOSED';

export type PlanOutcome = 'draft_plan_created' | 'no_actions_needed' | 'same_cycle_no_plan' | 'external_result_no_plan';

/**
 * Only internal (hospital) results drive improvement plans. External-auditor results exist for
 * comparison and release only (FR-024a, proposal A12): they never draft a plan, never count as the
 * first assessment of a cycle and never offer findings to a hospital plan.
 */
export function countsForPlanning(a: { assessorType: AssessorType }): boolean {
  return a.assessorType !== 'external';
}

export interface LocalizedTitle { en: string; hi?: string; kn?: string }

export interface CatalogueQuestionLike {
  questionKey: string;
  elevateQuestionExternalId?: string;
  sectionKey: string;
  riskLevel: RiskLevel;
  passMark: number;
  maxScore: number;
  templateTaskKey?: string;
  answerType?: 'score' | 'yes_no' | 'single_choice';
  options?: { value: string; score: number }[];
  text?: LocalizedTitle;
}

export interface RiskDefaultLike {
  riskLevel: RiskLevel;
  dueDays: number;
  evidenceRule: { photoRequired: boolean; minPhotos: number };
  secondValidation: boolean;
}

/** One answer of the samiksha `completed` event (`answers[qid]`). */
export interface EventAnswer {
  externalId?: string;
  value?: unknown;
  scoreAchieved?: number;
  maxScore?: number;
  percentageScore?: number;
  options?: { value: string; score?: number }[];
}

export interface DraftTask {
  taskKey: string;
  title: LocalizedTitle;
  sourceQuestionKey?: string;
  riskLevel: RiskLevel;
  ownerUserId?: string;
  dueAt: Date;
  dependsOnTaskKeys: string[];
  evidenceRule: { photoRequired: boolean; minPhotos: number };
  secondValidation: boolean;
  included: boolean;
}

// ------------------------------------------------------------------------------------- scoring (E8)

export interface SubmissionScore {
  total: number;
  bySection: Record<string, number>;
  failedQuestionKeys: string[];
  /** Score per programme question key (US7 cross-version comparison). */
  byQuestion: Record<string, number>;
  /** `event` = ELEVATE's own scores; `catalogue` = computed from answers with catalogue pass marks. */
  source: 'event' | 'catalogue';
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const selected = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

/**
 * Fraction (0..1) of the question achieved, from ELEVATE's per-answer score. The raw points come
 * first: samiksha reports `percentageScore: 0` for a fully scored multi-select (observed
 * 2026-11-23: scoreAchieved 120 / maxScore 120, percentageScore 0).
 */
function eventFraction(a: EventAnswer): number | undefined {
  if (typeof a.scoreAchieved === 'number' && typeof a.maxScore === 'number' && a.maxScore > 0) return Math.min(1, a.scoreAchieved / a.maxScore);
  if (typeof a.percentageScore === 'number' && Number.isFinite(a.percentageScore)) return a.percentageScore / 100;
  return undefined;
}

/**
 * Deterministic fallback (E8): catalogue option scores first (on the catalogue scale), then the
 * option scores the event carries (multi-select: sum of chosen / sum of all), then yes/no.
 * An answer that cannot be scored counts as 0, so the finding reaches the officer.
 */
function catalogueFraction(q: CatalogueQuestionLike, a: EventAnswer): number {
  const picks = selected(a.value);
  if (q.options?.length) {
    const byValue = new Map(q.options.map((o) => [o.value, o.score]));
    const got = picks.reduce((s, p) => s + (byValue.get(p) ?? 0), 0);
    return q.maxScore > 0 ? Math.min(1, got / q.maxScore) : 0;
  }
  const opts = (a.options ?? []).filter((o): o is { value: string; score: number } => typeof o.score === 'number');
  if (opts.length) {
    const byValue = new Map(opts.map((o) => [o.value, o.score]));
    const got = picks.reduce((s, p) => s + (byValue.get(p) ?? 0), 0);
    const max = Array.isArray(a.value) ? opts.reduce((s, o) => s + Math.max(0, o.score), 0) : Math.max(...opts.map((o) => o.score));
    return max > 0 ? Math.min(1, got / max) : 0;
  }
  if (q.answerType === 'yes_no') return picks.some((p) => /^(yes|true|1)$/i.test(p)) ? 1 : 0;
  return 0;
}

/**
 * Scores a completed submission against the catalogue (FR-011, E8). Answers are matched by the
 * ROOT ELEVATE externalId (copies append `-<epoch>`), so every checklist version maps back to the
 * stable programme key. Scores are on the catalogue scale; a question fails below its pass mark.
 */
export function scoreSubmission(
  questions: CatalogueQuestionLike[],
  answers: Record<string, EventAnswer> | EventAnswer[],
  o: { eventScored: boolean },
): SubmissionScore {
  const byRoot = new Map<string, EventAnswer>();
  for (const a of Array.isArray(answers) ? answers : Object.values(answers)) {
    if (a && typeof a.externalId === 'string') byRoot.set(rootExternalId(a.externalId), a);
  }
  let usedEvent = false;
  let total = 0;
  const bySection: Record<string, number> = {};
  const failed: string[] = [];
  const byQuestion: Record<string, number> = {};
  for (const q of questions) {
    const a = q.elevateQuestionExternalId ? byRoot.get(rootExternalId(q.elevateQuestionExternalId)) : undefined;
    if (!a) continue;
    const fromEvent = o.eventScored ? eventFraction(a) : undefined;
    if (fromEvent !== undefined) usedEvent = true;
    const score = round2((fromEvent ?? catalogueFraction(q, a)) * q.maxScore);
    bySection[q.sectionKey] = round2((bySection[q.sectionKey] ?? 0) + score);
    byQuestion[q.questionKey] = score;
    total += score;
    if (score < q.passMark) failed.push(q.questionKey);
  }
  return { total: round2(total), bySection, failedQuestionKeys: failed, byQuestion, source: usedEvent ? 'event' : 'catalogue' };
}

// ----------------------------------------------------------------------------------- drafting (FR-011)

/** `segregate-waste-at-source` → `Segregate waste at source` (last-resort title). */
export function humanizeKey(key: string): string {
  const s = key.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Still-open tasks of the previous plan, linked (never copied) by a repeat-cycle draft (FR-018). */
export function carryOverTaskIds(previous: { id: string; state: TaskStateName }[]): string[] {
  return previous.filter((t) => t.state !== 'CLOSED').map((t) => t.id);
}

export interface DraftDecision {
  outcome: PlanOutcome;
  draftTasks: DraftTask[];
  carriedOverTaskIds: string[];
}

/**
 * What a completed assessment produces (FR-011, FR-018, US3 AS1/4/5/7):
 * - an external-auditor result → never a plan (FR-024a, A12);
 * - a later assessment in the same cycle → no plan (its findings may be added by revision);
 * - no failed questions → no plan ("no actions needed"); open tasks stay on the previous plan;
 * - otherwise one draft: the mapped template task per failed question, defaults from its risk level.
 */
export function decideDraft(i: {
  questions: CatalogueQuestionLike[];
  failedQuestionKeys: string[];
  firstInCycle: boolean;
  riskDefaults: RiskDefaultLike[];
  templateTasks?: { templateTaskKey: string; title: LocalizedTitle }[];
  now: Date;
  previousPlanTasks?: { id: string; state: TaskStateName }[];
  /** Defaults to `internal`. */
  assessorType?: AssessorType;
}): DraftDecision {
  if (!countsForPlanning({ assessorType: i.assessorType ?? 'internal' })) return { outcome: 'external_result_no_plan', draftTasks: [], carriedOverTaskIds: [] };
  if (!i.firstInCycle) return { outcome: 'same_cycle_no_plan', draftTasks: [], carriedOverTaskIds: [] };
  const failed = new Set(i.failedQuestionKeys);
  const questions = i.questions.filter((q) => failed.has(q.questionKey));
  if (questions.length === 0) return { outcome: 'no_actions_needed', draftTasks: [], carriedOverTaskIds: [] };

  const defaults = new Map(i.riskDefaults.map((d) => [d.riskLevel, d]));
  const titles = new Map((i.templateTasks ?? []).map((t) => [t.templateTaskKey, t.title]));
  const byKey = new Map<string, DraftTask>();
  for (const q of questions) {
    const d = defaults.get(q.riskLevel);
    if (!d) throw Problem.unprocessable('VALIDATION_FAILED', `No risk default for ${q.riskLevel}`);
    const taskKey = q.templateTaskKey ?? q.questionKey;
    const task: DraftTask = {
      taskKey,
      title: { ...(titles.get(taskKey) ?? q.text ?? { en: humanizeKey(taskKey) }) },
      sourceQuestionKey: q.questionKey,
      riskLevel: q.riskLevel,
      dueAt: new Date(i.now.getTime() + d.dueDays * DAY_MS),
      dependsOnTaskKeys: [],
      evidenceRule: { ...d.evidenceRule },
      secondValidation: d.secondValidation,
      included: true,
    };
    const existing = byKey.get(taskKey);
    // Two findings → one template task: keep the stricter (higher-risk) defaults.
    if (!existing || RISK_ORDER[task.riskLevel] > RISK_ORDER[existing.riskLevel]) byKey.set(taskKey, task);
  }
  const draftTasks = [...byKey.values()].sort((a, b) => RISK_ORDER[b.riskLevel] - RISK_ORDER[a.riskLevel]);
  return { outcome: 'draft_plan_created', draftTasks, carriedOverTaskIds: carryOverTaskIds(i.previousPlanTasks ?? []) };
}

// --------------------------------------------------------------------------- editing / approval (FR-012)

export interface DraftTaskUpdate {
  taskKey: string;
  ownerUserId?: string;
  dueAt?: Date;
  dependsOnTaskKeys?: string[];
  included?: boolean;
}

const invalid = (path: string, message: string) =>
  Problem.unprocessable('VALIDATION_FAILED', message, { errors: [{ path, message }] });

function assertAcyclic(tasks: DraftTask[]): void {
  const deps = new Map(tasks.map((t) => [t.taskKey, t.dependsOnTaskKeys]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) throw invalid('tasks', `Task dependencies are circular (${k})`);
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d);
    state.set(k, 2);
  };
  for (const k of deps.keys()) visit(k);
}

/** Applies the officer's edits (owners, due dates, dependencies, inclusion) to the draft tasks. */
export function applyDraftUpdate(tasks: DraftTask[], updates: DraftTaskUpdate[]): DraftTask[] {
  const out = tasks.map((t) => ({ ...t, dependsOnTaskKeys: [...t.dependsOnTaskKeys] }));
  const byKey = new Map(out.map((t) => [t.taskKey, t]));
  updates.forEach((u, i) => {
    const t = byKey.get(u.taskKey);
    if (!t) throw invalid(`tasks[${i}].taskKey`, `${u.taskKey} is not a task of this draft`);
    if (u.ownerUserId !== undefined) t.ownerUserId = u.ownerUserId;
    if (u.dueAt !== undefined) t.dueAt = u.dueAt;
    if (u.included !== undefined) t.included = u.included;
    if (u.dependsOnTaskKeys !== undefined) {
      const deps = [...new Set(u.dependsOnTaskKeys)];
      if (deps.includes(u.taskKey)) throw invalid(`tasks[${i}].dependsOnTaskKeys`, 'A task cannot depend on itself');
      const unknown = deps.find((d) => !byKey.has(d));
      if (unknown) throw invalid(`tasks[${i}].dependsOnTaskKeys`, `${unknown} is not a task of this draft`);
      t.dependsOnTaskKeys = deps;
    }
  });
  assertAcyclic(out);
  return out;
}

/** Every included task has an owner; dependencies point at included tasks; at least one task. */
export function assertApprovable(tasks: DraftTask[]): void {
  const included = tasks.filter((t) => t.included);
  if (included.length === 0) throw invalid('tasks', 'A plan needs at least one task');
  const keys = new Set(included.map((t) => t.taskKey));
  const errors: { path: string; message: string }[] = [];
  included.forEach((t) => {
    if (!t.ownerUserId) errors.push({ path: `tasks.${t.taskKey}.ownerUserId`, message: 'Choose an owner for this task' });
    const missing = t.dependsOnTaskKeys.find((d) => !keys.has(d));
    if (missing) errors.push({ path: `tasks.${t.taskKey}.dependsOnTaskKeys`, message: `${missing} is not included in the plan` });
  });
  if (errors.length) {
    throw Problem.unprocessable('VALIDATION_FAILED', errors.map((e) => e.message).join('; '), { errors });
  }
}

// --------------------------------------------------------------------------------- revisions (FR-017)

/** Draft = revision 0; approval records revision 1; each later change +1. */
export function nextRevision(current: number): number {
  if (!Number.isInteger(current) || current < 0) throw new Error(`invalid plan revision ${current}`);
  return current + 1;
}

export interface RevisionChange { op: 'add' | 'remove' | 'update'; taskId: string; before?: unknown; after?: unknown }

export function planRevisionChanges(changes: RevisionChange[]): RevisionChange[] {
  if (changes.length === 0) throw invalid('changes', 'A revision needs at least one change');
  return changes.map((c) => ({ op: c.op, taskId: c.taskId, ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}) }));
}

// ------------------------------------------------------------------- ELEVATE task set (E9, FR-019)

/** ELEVATE project display status for a programme task state (the programme stays authoritative). */
export function elevateStatusOf(state: TaskStateName): 'notStarted' | 'inProgress' | 'completed' {
  if (state === 'ASSIGNED') return 'notStarted';
  if (state === 'CLOSED') return 'completed';
  return 'inProgress';
}

export interface ProgrammeTaskRef {
  id: string;
  taskKey: string;
  title: string;
  state: TaskStateName;
  elevateTaskId?: string;
  /** Id to use when the task must be added to ELEVATE (tests pass one; otherwise a UUID). */
  newElevateId?: string;
}

export interface ProjectTaskLike {
  _id: string;
  name: string;
  status?: string;
  isDeleted?: boolean;
  externalId?: string;
  description?: string;
}

export interface SyncEntry { _id: string; name: string; status: string; isNew?: boolean; isDeleted?: boolean }

export interface Correction {
  kind: 'status' | 'missing' | 'extra';
  taskId?: string;
  elevateTaskId: string;
  from?: string;
  to?: string;
}

/** A template task in an imported project: `description` holds the template task key, externalId `<prefix>TASK-<key>-<epoch>`. */
function templateKeyMatches(p: ProjectTaskLike, key: string): boolean {
  if (p.description === key) return true;
  return !!p.externalId && new RegExp(`TASK-${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-\\d{10,13})*$`).test(p.externalId);
}

/**
 * One-way diff programme → ELEVATE (E9, FR-019): the programme tasks are the truth. Links each
 * programme task to its ELEVATE task (by id, else by template key), lists the `userProjects/sync`
 * entries that make ELEVATE match (status, re-add missing, soft-delete extras) and the corrections.
 */
export function diffProjectTasks(tasks: ProgrammeTaskRef[], project: ProjectTaskLike[]): {
  links: Record<string, string>;
  sync: SyncEntry[];
  corrections: Correction[];
} {
  const live = project.filter((p) => !p.isDeleted);
  const used = new Set<string>();
  const links: Record<string, string> = {};
  const sync: SyncEntry[] = [];
  const corrections: Correction[] = [];
  for (const t of tasks) {
    const want = elevateStatusOf(t.state);
    const match = t.elevateTaskId
      ? live.find((p) => p._id === t.elevateTaskId)
      : live.find((p) => !used.has(p._id) && templateKeyMatches(p, t.taskKey));
    if (match) {
      used.add(match._id);
      links[t.id] = match._id;
      if (match.status !== want) {
        sync.push({ _id: match._id, name: match.name, status: want });
        corrections.push({ kind: 'status', taskId: t.id, elevateTaskId: match._id, ...(match.status ? { from: match.status } : {}), to: want });
      }
      continue;
    }
    const id = t.newElevateId ?? randomUUID();
    links[t.id] = id;
    used.add(id);
    sync.push({ _id: id, name: t.title, status: want, isNew: true });
    corrections.push({ kind: 'missing', taskId: t.id, elevateTaskId: id, to: want });
  }
  for (const p of live) {
    if (used.has(p._id)) continue;
    sync.push({ _id: p._id, name: p.name, status: p.status ?? 'notStarted', isDeleted: true });
    corrections.push({ kind: 'extra', elevateTaskId: p._id, ...(p.status ? { from: p.status } : {}) });
  }
  return { links, sync, corrections };
}
