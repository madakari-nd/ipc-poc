import type { ClientSession, Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import {
  assertEditable,
  countsByRisk,
  deriveDraftFromBase,
  effectiveStatus,
  nextVersionNumber,
  planPublication,
  validateDraftContent,
  type CatalogueQuestion,
  type CatalogueSection,
  type ChecklistStatus,
} from '../domain/catalogue.js';
import type { LedgerActor } from '../domain/ledger-chain.js';
import { ChecklistVersionModel, type ChecklistVersion } from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { withTx } from '../repositories/tx.js';
import type { ElevateAdminPort } from './elevate-admin.gateway.js';
import type { Outbox } from './outbox.publisher.js';
import { decodeCursor, encodeCursor, type Page } from './paging.js';

type PlanTemplateTask = { templateTaskKey: string; title: { en: string; hi?: string; kn?: string }; description?: { en: string; hi?: string; kn?: string } };

export interface DraftInput {
  checklistCode: string;
  basedOnVersionId?: string;
  sections?: CatalogueSection[];
  questions?: CatalogueQuestion[];
  planTemplateTasks?: PlanTemplateTask[];
}
export type DraftUpdate = Omit<DraftInput, 'checklistCode' | 'basedOnVersionId'>;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const iso = (d?: Date | null) => (d ? d.toISOString() : undefined);

/** Contract `ChecklistVersion`. Status is the effective one (a version past its grace period reads as retired). */
export function toChecklistVersionDto(d: ChecklistVersion, now: Date) {
  return {
    id: String(d._id),
    v: d.v,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    checklistCode: d.checklistCode,
    version: d.version,
    status: effectiveStatus(d, now),
    ...(d.elevateSolutionId ? { elevateSolutionId: d.elevateSolutionId } : {}),
    ...(d.elevateObservationTemplateId ? { elevateObservationTemplateId: d.elevateObservationTemplateId } : {}),
    ...(d.publishedAt ? { publishedAt: iso(d.publishedAt) } : {}),
    ...(d.graceUntil ? { graceUntil: iso(d.graceUntil) } : {}),
    ...(d.contentHash ? { contentHash: d.contentHash } : {}),
    planTemplate: {
      ...(d.planTemplate?.elevateTemplateId ? { elevateTemplateId: d.planTemplate.elevateTemplateId } : {}),
      version: d.planTemplate?.version ?? d.version,
      ...(d.planTemplate?.tasks?.length ? { tasks: d.planTemplate.tasks.map((t) => ({ ...t })) } : {}),
    },
    sections: (d.sections ?? []).map((s) => ({ sectionKey: s.sectionKey, title: { ...s.title } as { en: string }, wardTypes: [...s.wardTypes] })),
    questions: (d.questions ?? []).map((q) => ({
      questionKey: q.questionKey,
      ...(q.elevateQuestionExternalId ? { elevateQuestionExternalId: q.elevateQuestionExternalId } : {}),
      sectionKey: q.sectionKey,
      // seeded versions carry only the text hash: the key is the readable fallback
      text: q.text ? ({ ...q.text } as { en: string }) : { en: q.questionKey },
      ...(q.textHash ? { textHash: q.textHash } : {}),
      ...(q.answerType ? { answerType: q.answerType } : {}),
      ...(q.options?.length ? { options: q.options.map((o) => ({ ...o })) } : {}),
      riskLevel: q.riskLevel,
      passMark: q.passMark,
      maxScore: q.maxScore,
      ...(q.templateTaskKey ? { templateTaskKey: q.templateTaskKey } : {}),
    })),
  };
}
export type ChecklistVersionDto = ReturnType<typeof toChecklistVersionDto>;

/**
 * Checklist catalogue (T071, FR-005, research E5/E19). Drafts are edited here; publishing copies the
 * ELEVATE observation solution (v1 from the template, v(n+1) from v(n)) with importFromSolution,
 * points the copy at the `ward` entity type, then in ONE transaction makes the version immutable,
 * starts v(n)'s 7-day grace period, writes the ledger and enqueues `ipc.checklist.published`.
 */
export class CatalogueService {
  constructor(
    private readonly d: {
      ledger: LedgerService;
      outbox: Outbox;
      elevate: ElevateAdminPort;
      programmeNow: () => Date;
      prefix?: string;
    },
  ) {}

  private async load(id: string, session?: ClientSession): Promise<ChecklistVersion> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Problem.notFound('No such checklist version');
    const doc = await ChecklistVersionModel.findById(id, null, { session }).lean<ChecklistVersion>();
    if (!doc) throw Problem.notFound('No such checklist version');
    return doc;
  }

  async list(q: { checklistCode?: string; status?: ChecklistStatus; includeDrafts: boolean; cursor?: string; limit: number }): Promise<Page<ChecklistVersionDto>> {
    const now = this.d.programmeNow();
    const filter: Record<string, unknown> = {};
    if (q.checklistCode) filter.checklistCode = q.checklistCode;
    if (!q.includeDrafts) filter.status = { $ne: 'draft' };
    if (q.status === 'draft' && !q.includeDrafts) return { items: [], nextCursor: null };
    if (q.status === 'draft') filter.status = 'draft';
    if (q.status === 'retired') filter.$or = [{ status: 'retired' }, { status: 'published', graceUntil: { $lte: now } }];
    if (q.status === 'published') {
      filter.status = 'published';
      filter.$or = [{ graceUntil: null }, { graceUntil: { $gt: now } }];
    }
    const after = decodeCursor(q.cursor);
    if (after) filter._id = { $lt: after };
    const docs = await ChecklistVersionModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean<ChecklistVersion[]>();
    const items = docs.slice(0, q.limit).map((d) => toChecklistVersionDto(d, now));
    return { items, nextCursor: docs.length > q.limit ? encodeCursor(docs[q.limit - 1]!._id) : null };
  }

  async get(id: string, o: { includeDrafts: boolean }): Promise<ChecklistVersionDto> {
    const doc = await this.load(id);
    if (doc.status === 'draft' && !o.includeDrafts) throw Problem.notFound('No such checklist version');
    return toChecklistVersionDto(doc, this.d.programmeNow());
  }

  /** The published version new assessments use (US2 reads it). */
  async current(checklistCode: string): Promise<ChecklistVersion | null> {
    return ChecklistVersionModel.findOne({ checklistCode, status: 'published', graceUntil: null }).sort({ version: -1 }).lean<ChecklistVersion>();
  }

  private validateContent(sections: CatalogueSection[], questions: CatalogueQuestion[]) {
    const errors = validateDraftContent({ sections, questions });
    if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'The checklist content is not valid', { errors });
  }

  async createDraft(input: DraftInput, actor: LedgerActor): Promise<ChecklistVersionDto> {
    let base: ChecklistVersion | undefined;
    if (input.basedOnVersionId) {
      base = await this.load(input.basedOnVersionId).catch(() => {
        throw Problem.unprocessable('VALIDATION_FAILED', 'basedOnVersionId is not a checklist version');
      });
      if (base.checklistCode !== input.checklistCode) throw Problem.unprocessable('VALIDATION_FAILED', 'basedOnVersionId belongs to another checklist');
      if (base.status === 'draft') throw Problem.unprocessable('VALIDATION_FAILED', 'A draft can only be based on a published version');
    }
    const derived = base ? deriveDraftFromBase({ questions: base.questions as unknown as CatalogueQuestion[], sections: base.sections as unknown as CatalogueSection[] }) : { sections: [], questions: [] };
    const sections = input.sections ?? derived.sections;
    const questions = mergeQuestions(derived.questions, input.questions);
    this.validateContent(sections, questions);
    const versions = (await ChecklistVersionModel.find({ checklistCode: input.checklistCode }, { version: 1 }).lean<{ version: number }[]>()).map((v) => v.version);
    const version = nextVersionNumber(versions);
    const tasks = input.planTemplateTasks ?? base?.planTemplate?.tasks;
    try {
      return await withTx(async (session) => {
        const [doc] = await ChecklistVersionModel.create([{
          checklistCode: input.checklistCode,
          version,
          status: 'draft',
          ...(base ? { basedOnVersionId: base._id } : {}),
          planTemplate: {
            ...(base?.planTemplate?.elevateTemplateId ? { elevateTemplateId: base.planTemplate.elevateTemplateId } : {}),
            version,
            ...(tasks?.length ? { tasks } : {}),
          },
          sections,
          questions,
        }], { session });
        const dto = toChecklistVersionDto(doc!.toObject() as ChecklistVersion, this.d.programmeNow());
        await this.d.ledger.append({
          actor, action: 'checklist.draft_created', subject: { type: 'checklist_version', id: dto.id },
          reason: base ? `draft v${version} based on v${base.version}` : `draft v${version}`, afterHash: contentHash(dto),
        }, session);
        return dto;
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw Problem.conflict('VERSION_CONFLICT', 'Another draft took this version number; try again');
      throw err;
    }
  }

  /** Records a refused write on a published/retired version (US1 AS3) and throws 409 CHECKLIST_PUBLISHED. */
  private async refuse(doc: ChecklistVersion, actor: LedgerActor, what: string): Promise<never> {
    try {
      assertEditable(doc);
    } catch (problem) {
      await this.d.ledger.appendNow({
        actor, action: 'checklist.edit_refused', subject: { type: 'checklist_version', id: String(doc._id) },
        reason: `${what} refused: v${doc.version} is ${doc.status}`,
      });
      throw problem;
    }
    throw new Error('refuse() called on a draft');
  }

  private assertVersion(doc: ChecklistVersion, ifMatch: number | undefined) {
    if (ifMatch === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header is required');
    if (doc.v !== ifMatch) {
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this checklist since you opened it', {
        currentVersion: doc.v, current: toChecklistVersionDto(doc, this.d.programmeNow()),
      });
    }
  }

  async updateDraft(id: string, patch: DraftUpdate, ifMatch: number | undefined, actor: LedgerActor): Promise<ChecklistVersionDto> {
    const doc = await this.load(id);
    if (doc.status !== 'draft') await this.refuse(doc, actor, 'edit');
    this.assertVersion(doc, ifMatch);
    const sections = patch.sections ?? (doc.sections as unknown as CatalogueSection[]);
    const questions = patch.questions ? mergeQuestions(doc.questions as unknown as CatalogueQuestion[], patch.questions, true) : (doc.questions as unknown as CatalogueQuestion[]);
    this.validateContent(sections, questions);
    return withTx(async (session) => {
      const set: Record<string, unknown> = { sections, questions };
      if (patch.planTemplateTasks) set['planTemplate.tasks'] = patch.planTemplateTasks;
      const updated = await ChecklistVersionModel.findOneAndUpdate(
        { _id: doc._id, v: doc.v, status: 'draft' }, { $set: set, $inc: { v: 1 } }, { new: true, session, lean: true },
      );
      if (!updated) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this checklist since you opened it');
      const dto = toChecklistVersionDto(updated as ChecklistVersion, this.d.programmeNow());
      await this.d.ledger.append({
        actor, action: 'checklist.draft_updated', subject: { type: 'checklist_version', id },
        beforeHash: contentHash(toChecklistVersionDto(doc, this.d.programmeNow())), afterHash: contentHash(dto),
      }, session);
      return dto;
    });
  }

  async publish(id: string, ifMatch: number | undefined, actor: LedgerActor, reason?: string): Promise<ChecklistVersionDto> {
    const draft = await this.load(id);
    if (draft.status !== 'draft') await this.refuse(draft, actor, 'publish');
    this.assertVersion(draft, ifMatch);
    const previous = await this.current(draft.checklistCode);
    const now = this.d.programmeNow();
    // Validate before any ELEVATE call, so a bad draft never leaves an orphan solution in ELEVATE.
    planPublication({
      draft: { status: draft.status, version: draft.version, questions: draft.questions as unknown as CatalogueQuestion[], sections: draft.sections as unknown as CatalogueSection[] },
      previous: previous ? { id: String(previous._id), status: previous.status, version: previous.version } : null,
      now,
    });

    // ELEVATE first (it cannot join our transaction). v(n+1) copies v(n)'s solution (E5); v1 copies
    // the configured template unless the draft already points at a solution (seed-provisioned).
    let solution: { _id: string; externalId: string } | undefined;
    if (!draft.elevateSolutionId) {
      const source = previous?.elevateSolutionId ?? this.d.elevate.checklistTemplateSolutionId;
      if (!source) throw Problem.unprocessable('VALIDATION_FAILED', 'No ELEVATE checklist to copy: set IPC_CHECKLIST_TEMPLATE_SOLUTION_ID or publish a version with a solution first');
      solution = await this.d.elevate.copyChecklistSolution({
        sourceSolutionId: source,
        externalId: `${this.d.prefix ?? ''}${draft.checklistCode}-v${draft.version}-${Date.now()}`,
        name: `${this.d.prefix ?? ''}${draft.checklistCode} v${draft.version}`,
      });
    }

    return withTx(async (session) => {
      const fresh = await this.load(id, session);
      if (fresh.status !== 'draft') await this.refuse(fresh, actor, 'publish');
      this.assertVersion(fresh, ifMatch);
      const prev = await ChecklistVersionModel.findOne({ checklistCode: fresh.checklistCode, status: 'published', graceUntil: null }, null, { session })
        .sort({ version: -1 }).lean<ChecklistVersion>();
      const at = this.d.programmeNow();
      const plan = planPublication({
        draft: { status: fresh.status, version: fresh.version, questions: fresh.questions as unknown as CatalogueQuestion[], sections: fresh.sections as unknown as CatalogueSection[] },
        previous: prev ? { id: String(prev._id), status: prev.status, version: prev.version } : null,
        now: at,
      });
      const updated = await ChecklistVersionModel.findOneAndUpdate(
        { _id: fresh._id, v: fresh.v, status: 'draft' },
        {
          $set: {
            status: 'published',
            publishedAt: plan.publish.publishedAt,
            contentHash: plan.publish.contentHash,
            questions: plan.publish.questions,
            'planTemplate.version': fresh.planTemplate?.version ?? fresh.version,
            ...(solution ? { elevateSolutionId: solution._id, elevateSolutionExternalId: solution.externalId, elevateObservationTemplateId: solution.externalId } : {}),
          },
          $inc: { v: 1 },
        },
        { new: true, session, lean: true },
      );
      if (!updated) throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this checklist since you opened it');
      if (plan.retirePrevious) {
        await ChecklistVersionModel.updateOne(
          { _id: plan.retirePrevious.id }, { $set: { graceUntil: plan.retirePrevious.graceUntil }, $inc: { v: 1 } }, { session },
        );
        await this.d.ledger.append({
          actor, action: 'checklist.grace_started', subject: { type: 'checklist_version', id: plan.retirePrevious.id },
          reason: `replaced by v${fresh.version}; retires ${plan.retirePrevious.graceUntil.toISOString()}`,
        }, session);
      }
      const doc = updated as ChecklistVersion;
      const dto = toChecklistVersionDto(doc, at);
      await this.d.ledger.append({
        actor, action: 'checklist.published', subject: { type: 'checklist_version', id },
        reason: reason ?? `published v${doc.version}${solution ? ` (ELEVATE solution ${solution.externalId})` : ''}`,
        beforeHash: contentHash(toChecklistVersionDto(fresh, at)), afterHash: contentHash(dto),
      }, session);
      await this.d.outbox.enqueue({
        type: 'ipc.checklist.published',
        key: doc.checklistCode,
        actor,
        subject: { type: 'checklist_version', id },
        payload: {
          checklistVersionId: id,
          checklistCode: doc.checklistCode,
          version: doc.version,
          contentHash: plan.publish.contentHash,
          questionCount: plan.publish.questions.length,
          questionCountsByRisk: countsByRisk(plan.publish.questions),
          sectionKeys: doc.sections.map((s) => s.sectionKey),
          planTemplateVersion: doc.planTemplate?.version ?? doc.version,
          ...(doc.elevateSolutionId ? { elevateSolutionId: doc.elevateSolutionId } : {}),
          previousVersionId: plan.retirePrevious?.id ?? null,
          previousVersionGraceUntil: plan.retirePrevious?.graceUntil.toISOString() ?? null,
          publishedAt: plan.publish.publishedAt.toISOString(),
        },
      }, session);
      return dto;
    });
  }

  /** Ids of published or retired versions' ELEVATE solutions (the Edge proxy guard refuses edits to them). */
  async lockedSolutions(): Promise<{ elevateSolutionId: string; checklistVersionId: string }[]> {
    const docs = await ChecklistVersionModel.find({ status: { $ne: 'draft' }, elevateSolutionId: { $exists: true } }, { elevateSolutionId: 1 })
      .lean<{ _id: Types.ObjectId; elevateSolutionId: string }[]>();
    return docs.map((d) => ({ elevateSolutionId: d.elevateSolutionId, checklistVersionId: String(d._id) }));
  }
}

/**
 * Applies client question edits onto a base list by questionKey: a known key keeps its ELEVATE root
 * id unless the client gives one; unknown keys are new questions. With `replace`, the client list
 * is the full new list (order and removals); otherwise it only overrides/extends the base.
 */
function mergeQuestions(base: CatalogueQuestion[], incoming: CatalogueQuestion[] | undefined, replace = true): CatalogueQuestion[] {
  if (!incoming) return base;
  const byKey = new Map(base.map((q) => [q.questionKey, q]));
  const merged = incoming.map((q) => {
    const prev = byKey.get(q.questionKey);
    const rest: Partial<CatalogueQuestion> = { ...q };
    delete rest.textHash;
    return { ...(prev?.elevateQuestionExternalId ? { elevateQuestionExternalId: prev.elevateQuestionExternalId } : {}), ...rest } as CatalogueQuestion;
  });
  if (replace) return merged;
  const seen = new Set(merged.map((q) => q.questionKey));
  return [...base.filter((q) => !seen.has(q.questionKey)), ...merged];
}
