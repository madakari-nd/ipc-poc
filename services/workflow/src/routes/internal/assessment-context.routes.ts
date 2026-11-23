import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../../controllers/validate.js';
import type { AssessmentService } from '../../services/assessment.service.js';

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const ref = z.string().min(1).max(64);

/** Contract `AssessmentContextUpsert` (server-derived fields are refused: additionalProperties false). */
const upsertBody = z
  .object({
    elevateObservationId: ref,
    submissionNumber: z.number().int().min(1).optional(),
    wardId: oid,
    facilityId: oid,
    cycleId: oid,
    checklistVersionId: oid,
    assessorUserId: ref,
    assessorType: z.enum(['internal', 'external']),
    declaration: z
      .object({ accepted: z.literal(true), at: z.string().datetime({ offset: true }).transform((s) => new Date(s)) })
      .strict()
      .optional(),
    status: z.enum(['draft', 'submitted', 'completed']),
    evidenceIds: z.array(oid).max(300).optional(),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

/** PUT /internal/assessments/{elevateSubmissionId}/context — internalUpsertAssessmentContext (T079). */
export function assessmentContextRoutes(svc: AssessmentService, idempotency: RequestHandler): Router {
  const r = Router();
  r.put('/assessments/:elevateSubmissionId/context', idempotency, async (req, res) => {
    const subId = parseOrThrow(ref, req.params.elevateSubmissionId);
    const out = await svc.upsertContext(subId, parseOrThrow(upsertBody, req.body));
    res.setHeader('ETag', `"${out.dto.v}"`);
    res.status(out.created ? 201 : 200).json(out.dto);
  });
  return r;
}
