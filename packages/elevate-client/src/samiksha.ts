import { z } from 'zod';
import type { ElevateHttp } from './http.js';

const Envelope = <T extends z.ZodTypeAny>(result: T) => z.object({ result }).passthrough();

const Option = z.object({ value: z.string(), label: z.string().optional() }).passthrough();

export interface Question {
  _id: string;
  externalId?: string;
  responseType: string;
  question?: unknown;
  options?: { value: string; label?: string }[];
  criteriaId?: string;
  evidenceMethod?: string;
  pageQuestions?: Question[];
  payload?: { criteriaId?: string } & Record<string, unknown>;
  [k: string]: unknown;
}
const QuestionSchema: z.ZodType<Question> = z.lazy(() =>
  z.object({
    _id: z.string(),
    externalId: z.string().optional(),
    responseType: z.string(),
    // ELEVATE sends "" for options on pageQuestions containers
    options: z.union([z.array(Option), z.string()]).optional().transform((o) => (Array.isArray(o) ? o : undefined)),
    criteriaId: z.string().nullish().transform((v) => v ?? undefined),
    evidenceMethod: z.string().optional(),
    pageQuestions: z.array(QuestionSchema).optional(),
    // ELEVATE sends "" for payload on pageQuestions containers
    payload: z.union([z.object({ criteriaId: z.string().nullish().transform((v) => v ?? undefined) }).passthrough(), z.string(), z.null()]).optional()
      .transform((p) => (p && typeof p === 'object' ? p : undefined)),
  }).passthrough(),
) as unknown as z.ZodType<Question>;

export const AssessmentSchema = z.object({
  assessment: z.object({
    submissionId: z.string(),
    evidences: z.array(z.object({
      externalId: z.string(),
      name: z.string().optional(),
      sections: z.array(z.object({ code: z.string().optional(), questions: z.array(QuestionSchema) }).passthrough()),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
export type Assessment = z.infer<typeof AssessmentSchema>;

/** All answerable questions of an evidence method (pageQuestions flattened). */
export function flattenQuestions(evidence: Assessment['assessment']['evidences'][number]): Question[] {
  const walk = (qs: Question[]): Question[] =>
    qs.flatMap((q) => (q.responseType === 'pageQuestions' ? walk(q.pageQuestions ?? []) : [q]));
  return evidence.sections.flatMap((s) => walk(s.questions));
}

export interface Answer {
  qid: string;
  value: unknown;
  remarks?: string;
  fileName?: unknown[];
  payload?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
  criteriaId?: string;
  responseType: string;
  evidenceMethod?: string;
  rubricLevel?: string;
}

/** Builds an answer in the shape questionnaire-player sends (VAL/v5_observation_event.py). */
export function buildAnswer(q: Question, value: unknown, remarks = ''): Answer {
  const now = Date.now();
  return {
    qid: q._id, value, remarks, fileName: [],
    payload: { question: q.question, labels: Array.isArray(value) ? value.map(String) : [String(value)], responseType: q.responseType, filesNotUploaded: [] },
    startTime: now, endTime: now,
    criteriaId: q.payload?.criteriaId ?? q.criteriaId, responseType: q.responseType,
    evidenceMethod: q.evidenceMethod, rubricLevel: '',
  };
}

const SubmissionUpdate = Envelope(z.object({ _id: z.string(), status: z.string() }).passthrough());

export const SubmissionSummarySchema = z.object({
  _id: z.string(),
  status: z.string(),
  submissionNumber: z.number().optional(),
  evidencesStatus: z.array(z.object({ code: z.string().optional(), status: z.string().optional() }).passthrough()).optional(),
}).passthrough();

/**
 * Observation submission document as published on `elevate_observations_<env>` (E8). Score
 * fields are present on the `completed` event of a scored solution (observed 2026-11-23:
 * pointsBasedScoreAchieved/MaxScore/PercentageScore, criteria[].score, themes, ratingCompletedAt).
 */
export const ObservationSubmissionEventSchema = z.object({
  _id: z.string(),
  status: z.string(),
  observationId: z.string(),
  solutionId: z.string(),
  solutionExternalId: z.string().optional(),
  entityId: z.string(),
  entityExternalId: z.string().optional(),
  createdBy: z.string(),
  submissionNumber: z.number(),
  tenantId: z.string().optional(),
  orgId: z.string().optional(),
  scoringSystem: z.string().nullish(),
  isRubricDriven: z.boolean().optional(),
  pointsBasedScoreAchieved: z.number().optional(),
  pointsBasedMaxScore: z.number().optional(),
  pointsBasedPercentageScore: z.number().optional(),
  criteria: z.array(z.object({ externalId: z.string().optional(), score: z.unknown().optional() }).passthrough()).optional(),
  themes: z.array(z.unknown()).optional(),
  answers: z.record(z.unknown()).optional(),
  completedDate: z.string().optional(),
  ratingCompletedAt: z.string().optional(),
}).passthrough();
export type ObservationSubmissionEvent = z.infer<typeof ObservationSubmissionEventSchema>;

/** True when a completion event carries scores (preflight check 6). */
export function eventHasScores(e: ObservationSubmissionEvent): boolean {
  return typeof e.pointsBasedScoreAchieved === 'number' ||
    (e.criteria ?? []).some((c) => c.score !== undefined && c.score !== '');
}

/** ELEVATE samiksha / survey service (research E5–E8; register d2–d7). */
export class SamikshaClient {
  constructor(private readonly http: ElevateHttp) {}

  /** Solution + form metadata as a user sees it. */
  async solutionDetails(userToken: string, solutionId: string) {
    const r = await this.http.call({
      operation: 'solutions.details', method: 'POST', path: `/survey/v1/solutions/details/${encodeURIComponent(solutionId)}`,
      json: {}, auth: { userToken },
      schema: Envelope(z.object({ solution: z.object({ _id: z.string(), externalId: z.string().optional(), name: z.string().optional() }).passthrough() }).passthrough()),
    });
    return r.result;
  }

  /**
   * d2: new checklist version. Server-to-server: internal token only, tenant/org and acting user
   * in the body (controller falls back to body.tenantData / body.userId). Question externalIds are
   * renamed on copy, so callers keep their own key map per version.
   */
  async importFromSolution(input: {
    sourceSolutionExternalId: string; externalId: string; name: string; description?: string;
    programExternalId?: string; userId: string; tenantId?: string; orgId: string;
  }): Promise<{ _id: string; externalId: string }> {
    const r = await this.http.call({
      operation: 'solutions.importFromSolution', method: 'POST', path: '/survey/v1/solutions/importFromSolution',
      query: { solutionId: input.sourceSolutionExternalId },
      json: {
        externalId: input.externalId, name: input.name, description: input.description ?? input.name,
        ...(input.programExternalId ? { programExternalId: input.programExternalId } : {}),
        userId: input.userId, tenantData: { tenantId: input.tenantId ?? this.http.tenantCode, orgId: input.orgId },
      },
      auth: { internal: true },
      schema: Envelope(z.object({ _id: z.string(), externalId: z.string() }).passthrough()),
    });
    return r.result;
  }

  /**
   * d2b: update solution fields (CONFIGURE). The seed uses it to point a copied checklist at the
   * `ward` entity type. Note: ELEVATE's solutions/update $sets any field it is given; the Edge never
   * exposes this route.
   */
  /** `userToken` must belong to an org_admin (samiksha's ORG_ADMIN branch; no org lookup needed). */
  async updateSolution(userToken: string, solutionId: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.http.call({
      operation: 'solutions.update', method: 'POST', path: `/survey/v1/solutions/update/${encodeURIComponent(solutionId)}`,
      json: fields, auth: { userToken, internal: true }, // internal-only route in samiksha
    });
  }

  /** d3: one observation per ward, entity passed at create (updateEntities is broken, E6). */
  async createObservation(
    userToken: string, solutionId: string,
    input: { name: string; description?: string; entityId?: string; entityIds?: string[] },
  ): Promise<{ _id: string; solutionId?: string }> {
    // E6 (revised): one observation per assessor per solution, carrying every ward in their scope.
    const entities = input.entityIds ?? (input.entityId ? [input.entityId] : []);
    if (entities.length === 0) throw new Error('createObservation needs at least one entity');
    const r = await this.http.call({
      operation: 'observations.create', method: 'POST', path: '/survey/v1/observations/create', query: { solutionId },
      json: { data: { name: input.name, description: input.description ?? input.name, status: 'published', entities } },
      auth: { userToken }, schema: Envelope(z.object({ _id: z.string(), solutionId: z.string().optional() }).passthrough()),
    });
    return r.result;
  }

  /** d4: assessment form; creates the submission for that number if missing (not idempotent). */
  async assessmentForm(userToken: string, observationId: string, entityId: string, submissionNumber = 1): Promise<Assessment> {
    const r = await this.http.call({
      operation: 'observations.assessment', method: 'POST', path: `/survey/v1/observations/assessment/${encodeURIComponent(observationId)}`,
      query: { entityId, submissionNumber, ecmMethod: '' }, auth: { userToken }, schema: Envelope(AssessmentSchema),
    });
    return r.result;
  }

  /**
   * d5: submits one evidence method. ELEVATE does not check the submission owner (V5b): callers
   * MUST check ownership first. Observed 2026-11-23: the call that completes the LAST evidence can
   * answer 500 although the submission is completed and the event is published, so a 5xx here is
   * "unknown outcome": confirm with listSubmissions or the completion event, never blind-retry.
   */
  async submitEvidence(
    userToken: string, submissionId: string,
    evidence: { externalId: string; answers: Record<string, Answer>; startTime?: number; endTime?: number; isSubmitted?: boolean },
    gpsLocation?: string,
  ): Promise<{ _id: string; status: string }> {
    const now = Date.now();
    const r = await this.http.call({
      operation: 'observationSubmissions.update', method: 'POST',
      path: `/survey/v1/observationSubmissions/update/${encodeURIComponent(submissionId)}`,
      json: { evidence: { startTime: now, endTime: now, isSubmitted: true, ...evidence } },
      auth: { userToken }, headers: gpsLocation ? { gpslocation: gpsLocation } : undefined, schema: SubmissionUpdate,
    });
    return r.result;
  }

  /** d6: next submission (repeat assessment) for the same observation and entity. */
  async createSubmission(userToken: string, observationId: string, entityId: string): Promise<unknown> {
    const r = await this.http.call({
      operation: 'observationSubmissions.create', method: 'POST',
      path: `/survey/v1/observationSubmissions/create/${encodeURIComponent(observationId)}`, query: { entityId },
      json: {}, auth: { userToken },
    });
    return (r as { result?: unknown })?.result;
  }

  /** d7: submission status list (no scores; scores come from the Kafka event). */
  async listSubmissions(userToken: string, observationId: string, entityId: string) {
    const r = await this.http.call({
      operation: 'observationSubmissions.list', method: 'GET',
      path: `/survey/v1/observationSubmissions/list/${encodeURIComponent(observationId)}`, query: { entityId },
      auth: { userToken }, schema: Envelope(z.array(SubmissionSummarySchema)),
    });
    return r.result;
  }
}
