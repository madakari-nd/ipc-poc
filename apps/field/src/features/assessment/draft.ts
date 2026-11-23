import type { components } from '@ipc/contracts';
import type { Outbox } from '../../offline/outbox.js';
import type { CapturedPhoto } from '../capture/capture.js';

export type FormBundle = components['schemas']['FormBundle'];
export type BundleQuestion = FormBundle['questions'][number];
export type AssessmentContext = components['schemas']['AssessmentContext'];

/** Free text is at most 500 characters everywhere (FR-032). */
export const FREE_TEXT_MAX = 500;
/** A replaced checklist version stays usable for 7 days after the new one is published (US2 AS6). */
export const GRACE_DAYS = 7;

/** What `startAssessment` returns (only the fields the device keeps). */
export interface AssessmentStart {
  assessmentId: string;
  assessment: { id: string; v: number; wardId: string };
  formBundle: FormBundle;
}

export type AnswerValue = boolean | number | string;

export interface DraftPhoto {
  /** Outbox item id (the server evidence id is filled in when the photo is sent). */
  outboxId: string;
  sha256: string;
  sizeBytes: number;
  capturedAt: string;
  gps: { lat: number; lng: number; accuracyM: number } | null;
  gpsUnavailable: boolean;
}

export interface DraftAnswer {
  value?: AnswerValue;
  observation: string;
  photos: DraftPhoto[];
}

export type DraftState = 'editing' | 'queued' | 'read_only';

/** An assessment kept on the device (encrypted) from download until it is sent. */
export interface Draft {
  assessmentId: string;
  assessmentV: number;
  wardId: string;
  wardName: string;
  bundle: FormBundle;
  answers: Record<string, DraftAnswer>;
  notes: string;
  declaration: { accepted: boolean; at?: string };
  state: DraftState;
  /** Outbox item of the submission once queued. */
  submissionItemId?: string;
  /** Why the draft became read-only (problem code). */
  readOnlyReason?: string;
  updatedAt: string;
}

export function newDraft(s: AssessmentStart, wardName: string, now = Date.now()): Draft {
  return {
    assessmentId: s.assessmentId,
    assessmentV: s.assessment.v,
    wardId: s.assessment.wardId,
    wardName,
    bundle: s.formBundle,
    answers: Object.fromEntries(s.formBundle.questions.map((q) => [q.questionKey, { observation: '', photos: [] }])),
    notes: '',
    declaration: { accepted: false },
    state: 'editing',
    updatedAt: new Date(now).toISOString(),
  };
}

export function setAnswer(d: Draft, questionKey: string, patch: Partial<DraftAnswer>, now = Date.now()): Draft {
  const cur = d.answers[questionKey] ?? { observation: '', photos: [] };
  return { ...d, answers: { ...d.answers, [questionKey]: { ...cur, ...patch } }, updatedAt: new Date(now).toISOString() };
}

export type VersionStatus = 'current' | 'grace' | 'retired';

/** `graceUntil` is set once a newer version is published: before it the draft is still sent on this version. */
export function versionStatus(bundle: Pick<FormBundle, 'graceUntil'>, now = Date.now()): VersionStatus {
  if (!bundle.graceUntil) return 'current';
  return now <= Date.parse(bundle.graceUntil) ? 'grace' : 'retired';
}

export type ProblemCode = 'declaration_required' | 'too_long' | 'unanswered' | 'version_retired' | 'read_only';
export interface DraftProblem {
  field: string;
  code: ProblemCode;
}

/** Everything that blocks sending, in screen order. Empty = ready to submit. */
export function draftProblems(d: Draft, now = Date.now()): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (d.state === 'read_only') out.push({ field: 'version', code: 'read_only' });
  else if (versionStatus(d.bundle, now) === 'retired') out.push({ field: 'version', code: 'version_retired' });
  for (const q of d.bundle.questions) {
    const a = d.answers[q.questionKey];
    if (a?.value === undefined || a.value === '') out.push({ field: `answers.${q.questionKey}`, code: 'unanswered' });
    if ((a?.observation.length ?? 0) > FREE_TEXT_MAX) out.push({ field: `answers.${q.questionKey}.observation`, code: 'too_long' });
  }
  if (d.notes.length > FREE_TEXT_MAX) out.push({ field: 'notes', code: 'too_long' });
  if (!d.declaration.accepted) out.push({ field: 'declaration', code: 'declaration_required' });
  return out;
}

/**
 * Queues the photo in the outbox at once (encrypted on the device), linked to this assessment's
 * question, so it is sent before the assessment that references it (FR-009).
 */
export async function addPhoto(outbox: Outbox, d: Draft, questionKey: string, p: CapturedPhoto, label?: string): Promise<Draft> {
  const outboxId = await outbox.addEvidence({
    label: label ?? `${d.wardName}: ${questionKey}`,
    bytes: p.bytes,
    meta: {
      sha256: p.sha256,
      sizeBytes: p.sizeBytes,
      mime: p.mime,
      capturedAt: p.capturedAt,
      gps: p.gps,
      gpsUnavailable: p.gpsUnavailable,
      wardId: d.wardId,
      link: { type: 'question', id: `${d.assessmentId}:${questionKey}` },
    },
  });
  const cur = d.answers[questionKey] ?? { observation: '', photos: [] };
  const photo: DraftPhoto = { outboxId, sha256: p.sha256, sizeBytes: p.sizeBytes, capturedAt: p.capturedAt, gps: p.gps, gpsUnavailable: p.gpsUnavailable };
  return setAnswer(d, questionKey, { photos: [...cur.photos, photo] });
}

/** Drops a photo that was not sent yet (an already sent one simply stops being referenced). */
export async function removePhoto(outbox: Outbox, d: Draft, questionKey: string, outboxId: string): Promise<Draft> {
  await outbox.discard(outboxId).catch(() => undefined);
  const cur = d.answers[questionKey];
  if (!cur) return d;
  return setAnswer(d, questionKey, { photos: cur.photos.filter((p) => p.outboxId !== outboxId) });
}

/** Contract `AssessmentSubmission`; photos are `{ $evidence: <outbox id> }` until the outbox resolves them. */
export function submissionBody(d: Draft, o: { now: number; deviceId: string }) {
  return {
    checklistVersionId: d.bundle.checklistVersionId,
    bundleHash: d.bundle.bundleHash,
    declaration: { accepted: d.declaration.accepted, at: d.declaration.at ?? new Date(o.now).toISOString() },
    answers: d.bundle.questions.map((q) => {
      const a = d.answers[q.questionKey]!;
      return {
        questionKey: q.questionKey,
        value: a.value as AnswerValue,
        ...(a.observation.trim() ? { observation: a.observation.trim() } : {}),
        ...(a.photos.length ? { evidenceIds: a.photos.map((p) => ({ $evidence: p.outboxId })) } : {}),
      };
    }),
    ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    deviceId: o.deviceId,
    deviceSubmittedAt: new Date(o.now).toISOString(),
  };
}

/** Queues the submission behind all of its photos (one record, sent once). Throws when not ready. */
export async function queueSubmission(outbox: Outbox, d: Draft, o: { now: number; deviceId: string }): Promise<Draft> {
  const problems = draftProblems(d, o.now);
  if (problems.length) throw new DraftNotReady(problems);
  if (d.state === 'queued' && d.submissionItemId) return d;
  const photos = Object.values(d.answers).flatMap((a) => a.photos.map((p) => p.outboxId));
  const id = await outbox.addRecord({
    label: d.wardName,
    method: 'POST',
    path: `/ipc/v1/assessments/${d.assessmentId}/submission`,
    body: submissionBody(d, o),
    ifMatch: String(d.assessmentV),
    dependsOn: photos,
  });
  return { ...d, state: 'queued', submissionItemId: id, updatedAt: new Date(o.now).toISOString() };
}

export class DraftNotReady extends Error {
  constructor(readonly problems: DraftProblem[]) {
    super(problems.map((p) => p.code).join(', '));
    this.name = 'DraftNotReady';
  }
}

/** A refusal from the Edge that ends this draft: a retired version keeps it read-only (US2 AS6). */
export function applyRefusal(d: Draft, code: string | undefined): Draft {
  if (code === 'CHECKLIST_VERSION_RETIRED') return { ...d, state: 'read_only', readOnlyReason: code };
  return d;
}
