/**
 * Programme half of the seed (T054): workflow register, catalogue, rules, scope assignments,
 * back-dated C0 baselines and the Edge evidence metadata for the data-quality list. Every write
 * goes through the workflow models inside `withTx` with its ledger record (LedgerService.append);
 * scope assignments go through ScopeService.assign. Unchanged documents are left alone, so a
 * re-run writes nothing and appends no ledger record.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { contentHash } from '../../services/workflow/src/domain/canonical.js';
import type { LedgerActor } from '../../services/workflow/src/domain/ledger-chain.js';
import type { LedgerSubjectType } from '../../services/workflow/src/domain/models/ledger.js';
import {
  AssessmentContextModel, ChecklistVersionModel, ClockSettingModel, CycleModel, EscalationRuleModel, FacilityModel,
  MentorProfileCacheModel, ProgrammeModel, RetentionPolicyModel, RiskDefaultModel, ScopeAssignmentModel, WardModel,
} from '../../services/workflow/src/domain/models/index.js';
import type { Scope } from '../../services/workflow/src/domain/scope.js';
import { LedgerService } from '../../services/workflow/src/ledger/ledger.service.js';
import { withTx } from '../../services/workflow/src/repositories/tx.js';
import { ScopeService } from '../../services/workflow/src/services/scope.service.js';
import { createModels } from '../../services/edge/src/db/models.js';
import {
  ALL_WARDS, C0_BASELINES, CATALOGUE, CYCLES, DISTRICTS, ESCALATION_RULES, HOSPITALS, PEOPLE, PLAN_TASKS, QUESTION_MAX,
  RISK_DEFAULTS, SECTIONS, STATE, serviceSlug, WARD4_KEY, type ScopeDef,
} from './demo-data.js';
import { ORG_CODE, textHash } from './seed-elevate.js';
import { ROOT, type Profile, type SeedState } from './seed-env.js';

const require = createRequire(import.meta.url);
const SYSTEM: LedgerActor = { userId: 'system', role: 'SYSTEM' };

export interface ProgrammeSeedResult {
  writes: number;
  ledgerRecords: number;
  ward4: { wardId: string; facilityId: string; elevateEntityId: string; wardCode: string; serviceAccountUserId: string };
  scopes: Record<string, string>;
}

/** Refuses to seed into a server that holds ELEVATE's own databases (never write there). */
async function assertNotElevateMongo(): Promise<void> {
  const dbs = await mongoose.connection.db!.admin().listDatabases({ nameOnly: true });
  const elevate = dbs.databases.map((d) => d.name).filter((n) => /^elevate-|^templateCreationPortal$/.test(n));
  if (elevate.length) throw new Error(`refusing to write programme data next to ELEVATE databases (${elevate.join(', ')}); pass --mongo-url for the programme Mongo`);
}

/** Connects mongoose to ipc_<profile>; the Edge db is reached with useDb on the same client so one transaction covers both. */
export async function connectProgramme(url: string, profile: Profile) {
  await mongoose.connect(url, { dbName: `ipc_${profile}`, serverSelectionTimeoutMS: 5000 });
  await assertNotElevateMongo();
  return mongoose.connection;
}

/** Applies the workflow and edge collection/index migrations (both idempotent `up`s). */
async function applyMigrations(profile: Profile) {
  const wf = require(join(ROOT, 'services/workflow/migrations/20261123000001-workflow-collections-indexes.cjs')) as { up(db: unknown): Promise<void> };
  const edge = require(join(ROOT, 'services/edge/migrations/20261123000100-edge-collections.cjs')) as { up(db: unknown): Promise<void> };
  await wf.up(mongoose.connection.db);
  await edge.up(mongoose.connection.useDb(`edge_${profile}`).db);
}

/** JSON view used for change detection (ObjectIds → strings, Dates → ISO). */
const plain = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
function changed(existing: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return Object.keys(desired).some((k) => contentHash(plain(existing[k]) ?? null) !== contentHash(plain(desired[k]) ?? null));
}

export class ProgrammeSeeder {
  writes = 0;
  ledgerRecords = 0;
  private readonly ledger = new LedgerService(() => new Date());
  private readonly correlationId: string;

  constructor(
    private readonly profile: Profile,
    private readonly state: SeedState,
    private readonly prefix: string,
    private readonly log: (s: string) => void,
  ) {
    this.correlationId = `seed-${profile}-${Date.now()}`;
  }

  /** Upsert by `filter` with ledger `<subject>.created|updated` in the same transaction. */
  private async upsert<T>(
    model: Model<T>, subject: LedgerSubjectType, filter: Record<string, unknown>, desired: Record<string, unknown>,
    opts: { session?: ClientSession; label?: string } = {},
  ): Promise<Types.ObjectId> {
    const run = async (session: ClientSession) => {
      const existing = await model.findOne(filter as never, null, { session }).lean<Record<string, unknown>>();
      if (!existing) {
        const [doc] = await model.create([{ ...filter, ...desired }], { session });
        const d = (doc as unknown as { toObject(): Record<string, unknown> }).toObject();
        const id = d._id as Types.ObjectId;
        await this.ledger.append({
          actor: SYSTEM, action: `${subject}.created`, subject: { type: subject, id: String(id) }, reason: `demo seed${opts.label ? `: ${opts.label}` : ''}`,
          afterHash: contentHash(plain(d)), correlationId: this.correlationId,
        }, session);
        this.writes++; this.ledgerRecords++;
        return id;
      }
      const id = existing._id as Types.ObjectId;
      if (!changed(existing, desired)) return id;
      await model.updateOne({ _id: id } as never, { $set: desired, $inc: { v: 1 } } as never, { session });
      const after = await model.findById(id, null, { session }).lean();
      await this.ledger.append({
        actor: SYSTEM, action: `${subject}.updated`, subject: { type: subject, id: String(id) }, reason: `demo seed${opts.label ? `: ${opts.label}` : ''}`,
        beforeHash: contentHash(plain(existing)), afterHash: contentHash(plain(after)), correlationId: this.correlationId,
      }, session);
      this.writes++; this.ledgerRecords++;
      return id;
    };
    return opts.session ? run(opts.session) : withTx(run);
  }

  async run(mongoUrl: string): Promise<ProgrammeSeedResult> {
    await connectProgramme(mongoUrl, this.profile);
    await applyMigrations(this.profile);
    const p = this.prefix;
    const S = this.state;
    const users = S.users;

    // ---- Programme, facilities, wards (§1) ----------------------------------------------------
    this.log('  programme register');
    const stateEntityId = S.entities[STATE.code(p)]!;
    await this.upsert(ProgrammeModel, 'programme', { code: `IPC-${this.profile.toUpperCase()}` }, {
      name: `IPC programme (${this.profile})`, stateEntityId, elevateOrgId: ORG_CODE, profile: this.profile, languages: ['en', 'hi', 'kn'],
    });
    const facilityIds: Record<string, Types.ObjectId> = {};
    const wardIds: Record<string, Types.ObjectId> = {};
    for (const h of HOSPITALS) {
      facilityIds[h.key] = await this.upsert(FacilityModel, 'facility', { facilityCode: h.code(p) }, {
        elevateEntityId: S.entities[h.code(p)]!, name: h.name, districtCode: DISTRICTS.find((d) => d.key === h.district)!.code(p),
        // ELEVATE drops entity location (preflight check 3), so the register keeps it.
        level: 'district', location: h.location, status: 'active',
      }, { label: h.name });
      for (const w of h.wards) {
        wardIds[w.key] = await this.upsert(WardModel, 'ward', { facilityId: facilityIds[h.key], wardCode: w.code(p) }, {
          elevateEntityId: S.entities[w.code(p)]!, name: w.name, wardType: w.wardType, active: true,
          serviceAccountUserId: String(users[serviceSlug(w.key)]!.id),
        }, { label: `${h.name} ${w.name}` });
      }
    }

    // ---- Cycles with their own observation and plan solutions (FR-018a) ---------------------------
    this.log('  cycles');
    const cycleIds: Record<string, Types.ObjectId> = {};
    for (const cy of CYCLES) {
      const st = S.cycles[cy.code]!;
      cycleIds[cy.code] = await this.upsert(CycleModel, 'cycle', { code: cy.code }, {
        startsAt: new Date(cy.startsAt), endsAt: new Date(cy.endsAt),
        targetDates: { baselineBy: new Date(cy.baselineBy), repeatBy: new Date(cy.repeatBy) },
        elevateSolutionIds: { plan: st.planSolutionId, observation: st.observationSolutionId }, status: cy.status,
      });
    }

    // ---- Checklist v1 + plan template (§2) ----------------------------------------------------
    this.log('  checklist IPC-WARD v1 and plan template');
    const fq = S.formQuestions ?? [];
    if (fq.length < 2) throw new Error(`checklist form has ${fq.length} questions; the catalogue needs at least 2`);
    const questions = fq.slice(0, CATALOGUE.length).map((q, i) => {
      const cat = CATALOGUE[i]!;
      return {
        questionKey: cat.questionKey, elevateQuestionExternalId: q.externalId, sectionKey: cat.sectionKey,
        textHash: textHash(q.text), riskLevel: cat.riskLevel, passMark: QUESTION_MAX, maxScore: QUESTION_MAX,
        templateTaskKey: cat.templateTaskKey,
      };
    });
    const content = questions.map((q) => ({ k: q.questionKey, t: q.textHash }));
    const checklistId = await this.upsert(ChecklistVersionModel, 'checklist_version', { checklistCode: 'IPC-WARD', version: 1 }, {
      status: 'published', elevateSolutionId: S.checklist!._id, elevateObservationTemplateId: S.checklist!.externalId,
      publishedAt: new Date(CYCLES[0]!.startsAt), contentHash: contentHash(content),
      planTemplate: { elevateTemplateId: S.planTemplate!.templateId, version: 1 },
      sections: SECTIONS.map((s) => ({ ...s, title: { ...s.title } })), questions,
    }, { label: 'IPC-WARD v1 (sample samiksha form; IPC wording via SUP later)' });

    // ---- Rules (§2) -----------------------------------------------------------------------------
    this.log('  risk defaults and escalation rules R1-R3');
    for (const r of RISK_DEFAULTS) await this.upsert(RiskDefaultModel, 'risk_default', { riskLevel: r.riskLevel }, { dueDays: r.dueDays, evidenceRule: r.evidenceRule, secondValidation: r.secondValidation });
    for (const r of ESCALATION_RULES) await this.upsert(EscalationRuleModel, 'escalation_rule', { code: r.code }, { condition: r.condition, target: r.target, channels: r.channels, active: r.active });
    await this.upsert(RetentionPolicyModel, 'retention_policy', { profile: this.profile }, {
      evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5, purgeMode: 'dry_run', updatedBy: 'system',
    });
    await this.upsert(ClockSettingModel, 'clock', { profile: this.profile }, { offsetMs: 0 });

    // ---- Scope assignments (via ScopeService) and the mentor register -----------------------------
    this.log('  scope assignments and mentor register');
    const scopes: Record<string, string> = {};
    const scopeService = new ScopeService(this.ledger);
    const district = (k: string) => DISTRICTS.find((d) => d.key === k)!.code(p);
    const toScope = (s: ScopeDef): Scope => {
      switch (s.level) {
        case 'state': return { level: 'state' };
        case 'district': return { level: 'district', districtCode: district(s.district) };
        case 'facility': return { level: 'facility', facilityId: String(facilityIds[s.hospital]) };
        case 'facility_list': return { level: 'facility', facilityIds: s.hospitals.map((h) => String(facilityIds[h])) };
        case 'wards': return { level: 'wards', facilityId: String(facilityIds[s.hospital]), wardIds: s.wards.map((w) => String(wardIds[w])) };
        case 'own_tasks': return { level: 'own_tasks' };
      }
    };
    const describe = (s: ScopeDef): string => {
      switch (s.level) {
        case 'state': return 'state (both districts)';
        case 'district': return `district ${district(s.district)}`;
        case 'facility': return HOSPITALS.find((h) => h.key === s.hospital)!.name;
        case 'facility_list': return s.hospitals.map((h) => HOSPITALS.find((x) => x.key === h)!.name).join(' + ');
        case 'wards': return `${HOSPITALS.find((h) => h.key === s.hospital)!.name}: ${s.wards.map((w) => ALL_WARDS.find((x) => x.key === w)!.name).join(', ')}`;
        case 'own_tasks': return 'own tasks; facilities via accepted support requests';
      }
    };
    const validFrom = new Date(CYCLES[0]!.startsAt);
    for (const person of PEOPLE) {
      const userId = String(users[person.slug]!.id);
      scopes[person.slug] = describe(person.scope);
      const scope = toScope(person.scope);
      const existing = await ScopeAssignmentModel.findOne({ userId, role: person.role }).lean();
      if (!existing) {
        await scopeService.assign({ userId, role: person.role, scope, validFrom, source: 'hr_import' }, SYSTEM, 'demo seed');
        this.writes++; this.ledgerRecords++;
      } else if (changed(existing as unknown as Record<string, unknown>, { scope })) {
        // A changed demo scope is a new assignment: end the old one, add the new (history kept).
        await withTx(async (session) => {
          await ScopeAssignmentModel.updateOne({ _id: existing._id }, { $set: { validTo: new Date() }, $inc: { v: 1 } }, { session });
          await this.ledger.append({ actor: SYSTEM, action: 'scope.changed', subject: { type: 'scope_assignment', id: String(existing._id) }, reason: 'demo seed: scope ended', correlationId: this.correlationId }, session);
        });
        await scopeService.assign({ userId, role: person.role, scope, validFrom: new Date(), source: 'hr_import' }, SYSTEM, 'demo seed: scope changed');
        this.writes += 2; this.ledgerRecords += 2;
      }
      if (person.mentor) {
        await this.upsert(MentorProfileCacheModel, 'programme', { elevateMentorId: userId }, {
          skills: person.mentor.skills, languages: person.mentor.languages, refreshedAt: new Date('2026-11-01T00:00:00Z'),
        }, { label: `MentorProfileCache for ${person.slug} (no mentor ledger subject type: logged as type programme, id = cache id)` });
      }
    }

    // ---- Back-dated C0 baselines (US7/US8) + data-quality evidence ------------------------------
    this.log('  C0 baselines and data-quality evidence');
    const c0 = CYCLES.find((c) => c.status === 'closed')!.code;
    const officer = String(users['officer-a']!.id);
    const evidence = createModels(mongoose.connection.useDb(`edge_${this.profile}`, { useCache: true })).Evidence;
    for (const b of C0_BASELINES) {
      const sk = `${c0}:officer-a:${b.ward}`;
      const done = S.completed[sk];
      if (!done) throw new Error(`C0 baseline ${b.ward} missing in ELEVATE state`);
      const bySection: Record<string, number> = {};
      let total = 0;
      for (const q of questions) {
        const pts = done.answers[q.questionKey] ? q.maxScore : 0;
        bySection[q.sectionKey] = (bySection[q.sectionKey] ?? 0) + pts;
        total += pts;
      }
      const failed = questions.filter((q) => done.answers[q.questionKey] === false).map((q) => q.questionKey);
      const w = ALL_WARDS.find((x) => x.key === b.ward)!;
      await withTx(async (session) => {
        const ctxId = await this.upsert(AssessmentContextModel, 'assessment', { elevateSubmissionId: S.submissions[sk]! }, {
          elevateObservationId: S.observations[`${c0}:officer-a`]!, submissionNumber: 1, wardId: wardIds[b.ward], facilityId: facilityIds[w.hospital.key],
          cycleId: cycleIds[c0], checklistVersionId: checklistId, assessorUserId: officer, assessorType: 'internal', isBaselineForCycle: true,
          declaration: { accepted: true, at: new Date(b.completedAt) }, status: 'completed', completedAt: new Date(b.completedAt),
          scores: { total, bySection }, failedQuestionKeys: failed, releaseState: 'n/a',
        }, { session, label: `C0 baseline ${w.hospital.name} ${w.name} (back-dated)` });

        if (b.ward !== WARD4_KEY) return;
        // Two photos for the data-quality list (FR-026): one without GPS, one with clock skew > 10 min.
        const captured = new Date(b.completedAt);
        const items = [
          { name: 'no-gps', gps: null, gpsUnavailable: true, clockSkewSec: 0, receivedAt: new Date(captured.getTime() + 20 * 60_000) },
          { name: 'clock-skew', gps: { lat: w.hospital.location.lat + 0.0002, lng: w.hospital.location.lng + 0.0001, accuracyM: 12 }, gpsUnavailable: false, clockSkewSec: 1860, receivedAt: new Date(captured.getTime() + 45 * 60_000) },
        ];
        const ids: Types.ObjectId[] = [];
        for (const it of items) {
          const sha = createHash('sha256').update(`${this.profile}:${b.ward}:${it.name}`).digest('hex');
          const objectKey = `${this.profile}/${w.hospital.code(p)}/${w.code(p)}/${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
          ids.push(await this.upsert(evidence as unknown as Model<unknown>, 'evidence', { objectKey }, {
            sha256: sha, sizeBytes: 245_760, mime: 'image/jpeg', capturedAt: captured, receivedAt: it.receivedAt, clockSkewSec: it.clockSkewSec,
            gps: it.gps, gpsUnavailable: it.gpsUnavailable, uploadedBy: officer, deviceId: `${p.toLowerCase()}device-officer-a`,
            facilityId: String(facilityIds[w.hospital.key]), wardId: String(wardIds[b.ward]), districtCode: district(w.hospital.district),
            facilityLocation: w.hospital.location, link: { type: 'question', id: `${String(ctxId)}:hand_rub_at_bed` }, state: 'confirmed',
            confirmedAt: it.receivedAt, v: 0,
          }, { session, label: `evidence metadata only (${it.name}; no MinIO object)` }));
        }
        await this.upsert(AssessmentContextModel, 'assessment', { _id: ctxId }, { evidenceIds: ids }, { session, label: 'baseline evidence' });
      });
    }

    const w4 = ALL_WARDS.find((x) => x.key === WARD4_KEY)!;
    return {
      writes: this.writes, ledgerRecords: this.ledgerRecords, scopes,
      ward4: {
        wardId: String(wardIds[WARD4_KEY]), facilityId: String(facilityIds[w4.hospital.key]), elevateEntityId: S.entities[w4.code(p)]!,
        wardCode: w4.code(p), serviceAccountUserId: String(users[serviceSlug(WARD4_KEY)]!.id),
      },
    };
  }
}

export { PLAN_TASKS };
