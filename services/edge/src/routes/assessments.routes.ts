import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Problem } from '@ipc/platform';
import type { EdgeModels, EvidenceDoc } from '../db/models.js';
import { etag } from '../middleware/version.js';
import type { Auditor } from '../scope/audit.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import type { SessionService } from '../session/session.service.js';
import type { AssessmentElevate, AssessmentWorkflow, ElevateEvidence, ElevateQuestion, Upstream } from './assessments.ports.js';

// ------------------------------------------------------------------------------------------------
// Shapes (contract subsets the Edge reads)

export interface BundleQuestion {
  questionKey: string;
  sectionKey: string;
  elevateQuestionExternalId?: string;
  answerType?: 'score' | 'yes_no' | 'single_choice';
  options?: { value: string; score: number }[];
  passMark: number;
  maxScore: number;
}

export interface FormBundle {
  assessmentId: string;
  checklistVersionId: string;
  bundleHash: string;
  graceUntil?: string;
  questions: BundleQuestion[];
}

interface ContextDoc {
  id: string;
  v: number;
  elevateObservationId: string;
  elevateSubmissionId: string;
  submissionNumber?: number;
  wardId: string;
  facilityId: string;
  cycleId: string;
  checklistVersionId: string;
  assessorUserId: string;
  assessorType: 'internal' | 'external';
  status: 'draft' | 'submitted' | 'completed';
}

interface WardDto {
  id: string;
  facilityId: string;
  elevateEntityId: string;
  wardType: string;
  active: boolean;
}

interface SubmissionBody {
  checklistVersionId: string;
  bundleHash: string;
  declaration: { accepted: boolean; at: string };
  answers: { questionKey: string; value: number | string | boolean; observation?: string; evidenceIds?: string[] }[];
  notes?: string;
  deviceId?: string;
  deviceSubmittedAt: string;
}

/** samiksha submission states that mean "this submission is finished" (seed + preflight). */
export const DONE_STATES = new Set(['completed', 'ratingPending', 'ratingCompleted']);

// ------------------------------------------------------------------------------------------------
// Pure mapping (unit-tested): programme answers → samiksha evidence answers (E7)

const COPY_SUFFIX = /(?:-\d{10,13})+$/;
/** ELEVATE renames copied questions `<root>-<epoch>`; the root is stable across versions. */
export const rootExternalId = (externalId: string) => externalId.replace(COPY_SUFFIX, '');

/** Does an answer meet the question's pass mark? */
export function passes(q: BundleQuestion, value: number | string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value >= q.passMark;
  const opt = q.options?.find((o) => o.value === value);
  if (opt) return opt.score >= q.passMark;
  const n = Number(value);
  if (value.trim() !== '' && Number.isFinite(n)) return n >= q.passMark;
  return ['yes', 'true', 'pass', 'met'].includes(value.trim().toLowerCase());
}

/** All answerable questions of an evidence method (pageQuestions flattened). */
export function flattenQuestions(ev: ElevateEvidence): ElevateQuestion[] {
  const walk = (qs: ElevateQuestion[]): ElevateQuestion[] => qs.flatMap((q) => (q.responseType === 'pageQuestions' ? walk(q.pageQuestions ?? []) : [q]));
  return ev.sections.flatMap((s) => walk(s.questions ?? []));
}

/** samiksha value for pass/fail in the question's own response type (same rule as the seed). */
export function elevateValue(q: ElevateQuestion, pass: boolean, maxScore = 10): unknown {
  const opts = (q.options ?? []).map((o) => o.value);
  const pick = pass ? opts[opts.length - 1] : opts[0];
  switch (q.responseType) {
    case 'radio':
    case 'dropdown':
      return pick ?? '';
    case 'multiselect':
      return [pick ?? ''];
    case 'number':
    case 'slider':
      return pass ? maxScore : 0;
    case 'date':
      return new Date().toISOString();
    default:
      return pass ? 'Meets standard' : 'Not in place';
  }
}

/**
 * Answers for one samiksha evidence method. Answers carry the evidence ids (never files, FR-009) in
 * `payload.evidenceIds` and the remarks; questions the programme catalogue does not map are answered
 * as met so the form can complete.
 */
export function buildEvidenceAnswers(
  ev: ElevateEvidence,
  questions: BundleQuestion[],
  answers: SubmissionBody['answers'],
  o: { notes?: string; now?: number } = {},
): Record<string, Record<string, unknown>> {
  const byRoot = new Map(questions.filter((q) => q.elevateQuestionExternalId).map((q) => [rootExternalId(q.elevateQuestionExternalId!), q]));
  const byKey = new Map(answers.map((a) => [a.questionKey, a]));
  const now = o.now ?? Date.now();
  let notesUsed = false;
  const out: Record<string, Record<string, unknown>> = {};
  for (const q of flattenQuestions(ev)) {
    if (!q._id) continue;
    const cat = q.externalId ? byRoot.get(rootExternalId(q.externalId)) : undefined;
    const a = cat ? byKey.get(cat.questionKey) : undefined;
    const pass = cat && a ? passes(cat, a.value) : true;
    const value = elevateValue(q, pass, cat?.maxScore);
    const ids = a?.evidenceIds ?? [];
    const parts: string[] = [];
    if (cat && o.notes && !notesUsed) {
      parts.push(`Notes: ${o.notes}`);
      notesUsed = true;
    }
    if (a?.observation) parts.push(a.observation);
    if (ids.length) parts.push(`evidence: ${ids.join(',')}`);
    out[q._id] = {
      qid: q._id,
      value,
      remarks: parts.join(' | ').slice(0, 2000),
      fileName: [],
      payload: {
        question: q.question,
        labels: Array.isArray(value) ? value.map(String) : [String(value)],
        responseType: q.responseType,
        filesNotUploaded: [],
        ...(ids.length ? { evidenceIds: ids } : {}),
      },
      startTime: now,
      endTime: now,
      criteriaId: q.payload?.criteriaId ?? q.criteriaId,
      responseType: q.responseType,
      evidenceMethod: q.evidenceMethod,
      rubricLevel: '',
    };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Routes

export interface AssessmentRouteDeps {
  workflow: AssessmentWorkflow;
  elevate: AssessmentElevate;
}

interface Ctx {
  sessions: SessionService;
  guard: OwnershipGuard;
  audit: Auditor;
  models: EdgeModels;
  now: () => number;
}

const actorOf = (req: Request): Actor => {
  const role = req.scope?.activeRole;
  if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
  return { userId: req.scope.userId, role };
};

/** Re-raises a workflow refusal with its own status and code (problem extensions kept). */
function relay(out: Upstream, what: string): never {
  const p = (out.body ?? {}) as { code?: string; detail?: string } & Record<string, unknown>;
  if (out.status >= 500 || !p.code) {
    throw new Problem(503, 'STORAGE_UNAVAILABLE', `${what} is unavailable, try again shortly`, { unavailable: ['workflow'] });
  }
  const ext = Object.fromEntries(Object.entries(p).filter(([k]) => !['code', 'detail', 'type', 'title', 'status', 'correlationId', 'instance'].includes(k)));
  throw new Problem(out.status, p.code, p.detail, ext);
}

async function allPages<T>(wf: AssessmentWorkflow, actor: Actor, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await wf.get(actor, `${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status === 403 || r.status === 404) return out;
    if (r.status !== 200) relay(r, 'workflow');
    const page = r.body as { items: T[]; nextCursor: string | null };
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** Wards in the caller's scope (workflow filters `listFacilities` by the acting user). */
async function scopeWards(wf: AssessmentWorkflow, actor: Actor): Promise<WardDto[]> {
  const fs = await allPages<{ wards?: WardDto[] }>(wf, actor, '/ipc/v1/facilities?limit=100');
  return fs.flatMap((f) => f.wards ?? []);
}

async function formBundle(wf: AssessmentWorkflow, actor: Actor, id: string): Promise<FormBundle & Record<string, unknown>> {
  const r = await wf.get(actor, `/ipc/v1/assessments/${id}/form-bundle`);
  if (r.status !== 200) relay(r, 'The form');
  return r.body as FormBundle & Record<string, unknown>;
}

const unavailableDeps = () => new Problem(503, 'ELEVATE_UNAVAILABLE', 'Assessments are unavailable, try again shortly', { unavailable: ['assessments'] });

/**
 * US2 assessment routes (T078): assigned list, start (find or create the assessor's observation,
 * open the ward submission, return the offline form bundle), submit (declaration, confirmed
 * evidence, samiksha update with the user's token), baseline change. Contexts live in workflow.
 */
export function assessmentRoutes(deps: AssessmentRouteDeps | undefined, c: Ctx): Router {
  const r = Router();
  const need = (): AssessmentRouteDeps => {
    if (!deps) throw unavailableDeps();
    return deps;
  };
  const token = (req: Request) => c.sessions.elevateAccessToken(req.session!);

  // listAssessments: workflow filters by scope and hides held external results (FR-024a).
  r.get('/assessments', async (req: Request, res: Response) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
    const out = await need().workflow.get(actorOf(req), `/ipc/v1/assessments${q.size ? `?${q}` : ''}`);
    if (out.status !== 200) relay(out, 'Assessments');
    res.json(out.body);
  });

  // startAssessment (E6 revised): ONE observation per assessor per cycle solution; one submission per ward.
  r.post('/assessments', async (req: Request, res: Response) => {
    const { workflow, elevate } = need();
    const actor = actorOf(req);
    const { wardId, cycleId } = req.body as { wardId: string; cycleId: string };

    const wards = await scopeWards(workflow, actor);
    const ward = wards.find((w) => w.id === wardId);
    if (!ward) {
      await c.audit.record(req, 'scope.denied', { type: 'ward', id: wardId });
      throw Problem.forbidden('SCOPE_DENIED', 'This ward is outside your area.');
    }
    if (!ward.active) throw Problem.unprocessable('VALIDATION_FAILED', 'This ward is not active');

    const cycles = await allPages<{ id: string; status: string; elevateSolutionIds?: { observation?: string } }>(workflow, actor, '/ipc/v1/cycles?limit=100');
    const cycle = cycles.find((x) => x.id === cycleId);
    const solutionId = cycle?.elevateSolutionIds?.observation;
    if (!cycle || cycle.status === 'closed' || !solutionId) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'This cycle is not open for assessments', { errors: [{ path: 'cycleId', message: 'not an open cycle' }] });
    }

    // An open draft for this caller, ward and cycle is returned as it is (200).
    const open = await workflow.get(actor, `/ipc/v1/assessments?view=assigned&wardId=${wardId}&cycleId=${cycleId}&status=draft&limit=1`);
    if (open.status !== 200) relay(open, 'Assessments');
    const draft = (open.body as { items: ContextDoc[] }).items[0];
    if (draft) {
      res.setHeader('ETag', etag(draft.v));
      res.status(200).json({ assessmentId: draft.id, assessment: draft, formBundle: await formBundle(workflow, actor, draft.id) });
      return;
    }

    const checklists = await allPages<{ id: string; status: string; elevateSolutionId?: string; version: number }>(workflow, actor, '/ipc/v1/checklists?limit=100');
    const checklist = checklists.filter((x) => x.status !== 'draft' && x.elevateSolutionId === solutionId).sort((a, b) => b.version - a.version)[0];
    if (!checklist) throw Problem.unprocessable('VALIDATION_FAILED', 'No published checklist for this cycle');

    // ELEVATE with the user's own token: find the assessor's observation (never a second one: E11000).
    const t = await token(req);
    const findObs = async () => (await elevate.listObservations(t)).find((o) => o.solutionId === solutionId)?._id;
    let observationId = await findObs();
    if (!observationId) {
      const entities = [...new Set(wards.filter((w) => w.active).map((w) => w.elevateEntityId))];
      try {
        observationId = await elevate.createObservation(t, solutionId, { name: `${cycle.id} ${actor.userId}`, entities });
      } catch (err) {
        observationId = await findObs(); // created concurrently: use that one
        if (!observationId) throw err;
      }
    }

    const subs = (await elevate.listSubmissions(t, observationId, ward.elevateEntityId)).sort((a, b) => (a.submissionNumber ?? 1) - (b.submissionNumber ?? 1));
    const last = subs.at(-1);
    let submissionNumber = 1;
    if (last && DONE_STATES.has(last.status)) {
      await elevate.createSubmission(t, observationId, ward.elevateEntityId); // repeat assessment (d6)
      submissionNumber = (last.submissionNumber ?? subs.length) + 1;
    } else if (last) submissionNumber = last.submissionNumber ?? 1;
    const form = await elevate.assessmentForm(t, observationId, ward.elevateEntityId, submissionNumber);

    const up = await workflow.upsertContext(
      form.submissionId,
      {
        elevateObservationId: observationId,
        submissionNumber,
        wardId,
        facilityId: ward.facilityId,
        cycleId,
        checklistVersionId: checklist.id,
        assessorUserId: actor.userId,
        assessorType: actor.role === 'EXTERNAL_AUDITOR' ? 'external' : 'internal',
        status: 'draft',
      },
      randomUUID(),
    );
    if (up.status !== 200 && up.status !== 201) relay(up, 'Assessments');
    const ctx = up.body as ContextDoc;
    res.setHeader('ETag', etag(ctx.v));
    res.setHeader('Location', `/ipc/v1/assessments/${ctx.id}`);
    res.status(up.status).json({ assessmentId: ctx.id, assessment: ctx, formBundle: await formBundle(workflow, actor, ctx.id) });
  });

  r.get('/assessments/:assessmentId', c.guard.require('assessment', 'assessmentId', 'read'), (req: Request, res: Response) => {
    const d = req.resource!.doc as ContextDoc;
    res.setHeader('ETag', etag(d.v));
    res.json(d);
  });

  r.get('/assessments/:assessmentId/form-bundle', c.guard.require('assessment', 'assessmentId', 'read'), async (req: Request, res: Response) => {
    const b = await formBundle(need().workflow, actorOf(req), String(req.params.assessmentId));
    res.setHeader('ETag', `"${b.bundleHash}"`);
    res.json(b);
  });

  // submitAssessment (E7): declaration → version grace → answers → confirmed evidence → samiksha → context.
  r.post('/assessments/:assessmentId/submission', c.guard.require('assessment', 'assessmentId', 'owner'), async (req: Request, res: Response) => {
    const { workflow, elevate } = need();
    const actor = actorOf(req);
    const ctx = req.resource!.doc as ContextDoc;
    const body = req.body as SubmissionBody;

    if (body.declaration?.accepted !== true) throw Problem.unprocessable('DECLARATION_REQUIRED', 'Confirm the no-patient-data declaration');
    if (ctx.status !== 'draft') throw Problem.conflict('INVALID_TRANSITION', `This assessment is already ${ctx.status}`, { current: ctx });
    if (req.ifMatch !== undefined && req.ifMatch !== ctx.v) {
      throw Problem.conflict('VERSION_CONFLICT', 'This assessment changed since you downloaded it', { currentVersion: ctx.v, current: ctx });
    }

    const bundle = await formBundle(workflow, actor, ctx.id);
    if (body.checklistVersionId !== ctx.checklistVersionId) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'The form version does not match this assessment', { errors: [{ path: 'checklistVersionId', message: 'differs from the assessment' }] });
    }
    if (bundle.graceUntil && c.now() > Date.parse(bundle.graceUntil)) {
      throw Problem.unprocessable('CHECKLIST_VERSION_RETIRED', 'This checklist version was replaced more than 7 days ago. Start again on the new version.');
    }
    if (body.bundleHash !== bundle.bundleHash) {
      throw Problem.unprocessable('VALIDATION_FAILED', 'The form changed since it was downloaded. Download it again.', { errors: [{ path: 'bundleHash', message: 'does not match' }] });
    }

    // Answers: every question once, nothing unknown.
    const errors: { path: string; message: string }[] = [];
    const known = new Set(bundle.questions.map((q) => q.questionKey));
    const seen = new Set<string>();
    body.answers.forEach((a, i) => {
      if (!known.has(a.questionKey)) errors.push({ path: `answers[${i}].questionKey`, message: 'is not in this form' });
      if (seen.has(a.questionKey)) errors.push({ path: `answers[${i}].questionKey`, message: 'is answered twice' });
      seen.add(a.questionKey);
    });
    for (const k of known) if (!seen.has(k)) errors.push({ path: 'answers', message: `question ${k} is not answered` });

    // Evidence: confirmed, uploaded by the caller, for this assessment's question (FR-009).
    const refs = body.answers.flatMap((a, i) => (a.evidenceIds ?? []).map((id, j) => ({ id, path: `answers[${i}].evidenceIds[${j}]`, link: `${ctx.id}:${a.questionKey}` })));
    const docs = new Map(
      (await c.models.Evidence.find({ _id: { $in: refs.map((x) => x.id) } }).lean<EvidenceDoc[]>()).map((d) => [String(d._id), d]),
    );
    for (const x of refs) {
      const d = docs.get(x.id);
      if (!d || d.state !== 'confirmed') errors.push({ path: x.path, message: 'is not a confirmed photo' });
      else if (d.uploadedBy !== actor.userId || d.wardId !== ctx.wardId || d.link.type !== 'question' || d.link.id !== x.link) {
        errors.push({ path: x.path, message: 'belongs to another question or assessment' });
      }
    }
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'The assessment cannot be submitted yet', { errors: errors.slice(0, 50) });

    // samiksha with the caller's own token, after the scope and ownership checks above (V5b).
    const ward = (await scopeWards(workflow, actor)).find((w) => w.id === ctx.wardId);
    if (!ward) {
      await c.audit.record(req, 'scope.denied', { type: 'ward', id: ctx.wardId });
      throw Problem.forbidden('SCOPE_DENIED', 'This ward is outside your area.');
    }
    const t = await token(req);
    const status = async () =>
      (await elevate.listSubmissions(t, ctx.elevateObservationId, ward.elevateEntityId)).find((s) => s._id === ctx.elevateSubmissionId)?.status ?? '';
    if (!DONE_STATES.has(await status())) {
      const form = await elevate.assessmentForm(t, ctx.elevateObservationId, ward.elevateEntityId, ctx.submissionNumber ?? 1);
      if (form.submissionId !== ctx.elevateSubmissionId) throw Problem.conflict('VERSION_CONFLICT', 'The ELEVATE submission does not match this assessment');
      const pending = form.evidences.filter((e) => !e.isSubmitted);
      for (const [i, ev] of pending.entries()) {
        const now = c.now();
        const evidence = { externalId: ev.externalId, answers: buildEvidenceAnswers(ev, bundle.questions, body.answers, { notes: body.notes, now }), startTime: now, endTime: now, isSubmitted: true };
        try {
          await elevate.updateSubmission(t, ctx.elevateSubmissionId, evidence);
        } catch (err) {
          // Known samiksha quirk: completing the LAST evidence can answer 500 although it completed.
          if (i !== pending.length - 1 || !(err instanceof Problem) || err.status !== 503 || !DONE_STATES.has(await status())) throw err;
        }
      }
    }

    const up = await workflow.upsertContext(
      ctx.elevateSubmissionId,
      {
        elevateObservationId: ctx.elevateObservationId,
        ...(ctx.submissionNumber ? { submissionNumber: ctx.submissionNumber } : {}),
        wardId: ctx.wardId,
        facilityId: ctx.facilityId,
        cycleId: ctx.cycleId,
        checklistVersionId: ctx.checklistVersionId,
        assessorUserId: ctx.assessorUserId,
        assessorType: ctx.assessorType,
        declaration: { accepted: true, at: body.declaration.at },
        status: 'submitted',
        evidenceIds: [...new Set(refs.map((x) => x.id))],
        bundleHash: bundle.bundleHash,
      },
      randomUUID(),
    );
    if (up.status !== 200 && up.status !== 201) relay(up, 'Assessments');
    const out = up.body as ContextDoc;
    res.setHeader('ETag', etag(out.v));
    res.status(202).json(out);
  });

  // setAssessmentBaseline: scope check here, the rule and the ledger record in workflow.
  r.put('/assessments/:assessmentId/baseline', c.guard.require('assessment', 'assessmentId', 'read'), async (req: Request, res: Response) => {
    const id = String(req.params.assessmentId);
    const out = await need().workflow.put(actorOf(req), `/ipc/v1/assessments/${id}/baseline`, req.body, {
      ifMatch: req.ifMatch !== undefined ? etag(req.ifMatch) : undefined,
      idempotencyKey: randomUUID(),
    });
    if (out.status !== 200) relay(out, 'Assessments');
    const dto = out.body as ContextDoc;
    res.setHeader('ETag', etag(dto.v));
    res.json(dto);
  });

  return r;
}
