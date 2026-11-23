import type { Types } from 'mongoose';
import { defineSchema, elevateId, modelFor, ref, text } from './base.js';

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

// ---- AssessmentContext (§3): programme context for an ELEVATE submission
export interface AssessmentContext extends Meta {
  elevateObservationId: string; elevateSubmissionId: string; submissionNumber?: number;
  wardId: Types.ObjectId; facilityId: Types.ObjectId; cycleId: Types.ObjectId; checklistVersionId: Types.ObjectId;
  assessorUserId: string; assessorType: 'internal' | 'external'; isBaselineForCycle: boolean;
  baselineOfId?: Types.ObjectId; declaration?: { accepted: true; at: Date };
  status: 'draft' | 'submitted' | 'completed'; completedAt?: Date;
  scores?: { total?: number; bySection?: Map<string, number> }; failedQuestionKeys: string[];
  releaseState: 'n/a' | 'held' | 'released'; releasedBy?: string; releasedAt?: Date; evidenceIds: Types.ObjectId[];
}
export const AssessmentContextModel = modelFor<AssessmentContext>('AssessmentContext', defineSchema('assessment_contexts', {
  elevateObservationId: elevateId(true),
  elevateSubmissionId: elevateId(true),
  submissionNumber: { type: Number, min: 1 },
  wardId: ref(true),
  facilityId: ref(true),
  cycleId: ref(true),
  checklistVersionId: ref(true),
  assessorUserId: elevateId(true),
  assessorType: text({ required: true, enum: ['internal', 'external'] }),
  isBaselineForCycle: { type: Boolean, default: false },
  baselineOfId: ref(),
  declaration: { accepted: { type: Boolean, enum: [true] }, at: Date },
  status: text({ required: true, enum: ['draft', 'submitted', 'completed'] }),
  completedAt: Date,
  scores: { total: { type: Number, min: 0 }, bySection: { type: Map, of: Number } },
  failedQuestionKeys: [text({ max: 64 })],
  releaseState: text({ required: true, enum: ['n/a', 'held', 'released'] }),
  releasedBy: elevateId(),
  releasedAt: Date,
  evidenceIds: [ref()],
}));
