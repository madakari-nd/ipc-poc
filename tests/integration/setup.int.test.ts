/**
 * T068 (US1): programme setup against the REAL local ELEVATE (Constitution I: no ELEVATE mocks).
 * Facility and HR import create ELEVATE entities and users, scopes land in the programme layer,
 * leavers are deactivated with their scope ended; checklist v1 → v2 is copied with samiksha
 * importFromSolution + solutions/update (E19) and a cycle gets its own plan solution (FR-018a).
 *
 * The programme layer runs in-process (workflow app on an in-memory replica set, adapters importers
 * with their real ELEVATE client), so this test never touches the demo data (FR-040). Test data is
 * prefixed `PF-<profile>-us1-<ts>`. Skips cleanly when the env file or ELEVATE is missing.
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types, type Connection } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { createApp as createWorkflowApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { ElevateAdminGateway } from '../../services/workflow/src/services/elevate-admin.gateway.js';
import { workflowConfigSchema } from '../../services/workflow/src/config/index.js';
import { signServiceJwt } from '../../services/workflow/src/auth/service-jwt.js';
import { ScopeAssignmentModel, TaskModel } from '../../services/workflow/src/domain/models/index.js';
import { startMongo, type TestMongo } from '../../services/workflow/tests/helpers/mongo.js';
import { ImportService } from '../../services/adapters/src/importers/import.service.js';
import { createImportModels, type ImportJobDto } from '../../services/adapters/src/importers/job.js';
import { ElevateImportClient, HttpRegisterClient } from '../../services/adapters/src/importers/ports.js';

const profile = process.env.IPC_PROFILE ?? 'test';
const envPath = join(resolve(__dirname, '../..'), 'infra/compose', `.env.${profile}`);
const env = existsSync(envPath) ? readEnvFile(envPath) : {};

async function reachable(): Promise<string | undefined> {
  if (!existsSync(envPath)) return `${envPath} not found`;
  for (const k of ['ELEVATE_ADMIN_EMAIL', 'ELEVATE_ORG_ADMIN_EMAIL', 'DEMO_USER_PASSWORD']) if (!env[k]) return `${k} is not set (run the seed)`;
  try {
    const r = await fetch(`${env.ELEVATE_USER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? undefined : `user service health ${r.status}`;
  } catch (e) {
    return `ELEVATE unreachable at ${env.ELEVATE_USER_URL ?? '(unset)'}: ${(e as Error).message}`;
  }
}
const skipReason = await reachable();
if (skipReason) console.warn(`[setup.int] SKIPPED: ${skipReason}`);

const TS = Date.now();
const P = `PF-${profile}-us1-${TS}`;
const SECRET = 'integration-service-secret-0123456789';
const ADMIN_ACTOR = 'int-state-admin';
const mail = (who: string) => `pf-${profile}-us1-${who}-${TS}@example.org`.toLowerCase();

const FACILITY_CSV = [
  'facility_code,facility_name,district_code,level,lat,lng,status,ward_code,ward_name,ward_type,ward_active',
  ...[['D1', 'HA', 12.97, 77.59], ['D2', 'HB', 13.34, 77.1]].flatMap(([d, h, lat, lng]) =>
    ['W1:general', 'W2:OT', 'W4:ICU'].map((w) => {
      const [code, type] = w.split(':');
      return `${P}-${h},Hospital ${h},${P}-${d},district,${lat},${lng},active,${P}-${h}-${code},Ward ${code},${type},true`;
    })),
].join('\n');

const HR_CSV = (rows: string[]) => ['staff_id,name,email,role,status,district_code,facility_code,ward_codes,about', ...rows].join('\n');
const STAFF = [
  `${P}-S1,Asha Supervisor,${mail('sup')},WARD_SUPERVISOR,active,,${P}-HA,${P}-HA-W4,`,
  `${P}-S2,Ravi Officer,${mail('off')},IPC_OFFICER,active,,${P}-HB,,`,
  `${P}-S3,Meera Mentor,${mail('mentor')},MENTOR,active,,,,Infection control nurse`,
  `${P}-S4,Kiran Quality,${mail('dqm')},DISTRICT_QM,active,${P}-D1,,,`,
];

describe.skipIf(!!skipReason)('US1 programme setup on real ELEVATE', () => {
  let mongo: TestMongo;
  let adaptersConn: Connection;
  let server: Server;
  let elevate: ElevateClients;
  let imports: ImportService;
  const ctxRef: { ctx?: ReturnType<typeof createContext> } = {};

  const runImport = async (kind: 'facility' | 'hr', csv: string): Promise<ImportJobDto> => {
    const job = await imports.start({ kind, csv, dryRun: false, actorUserId: ADMIN_ACTOR });
    await imports.idle();
    return (await imports.get(job.id))!;
  };

  beforeAll(async () => {
    mongo = await startMongo(`ipc_us1_int_${TS}`);
    const cfg = workflowConfigSchema.parse({
      ...env, IPC_PROFILE: profile, DEMO_MODE: 'true', MONGO_URL: 'mongodb://unused', SERVICE_JWT_SECRET: SECRET,
      SCHEDULER_SHARED_SECRET: 'x'.repeat(16), ELEVATE_ORG_ID: env.ELEVATE_ORG_ID ?? '1', IPC_CODE_PREFIX: `PFI${TS % 1e7}-`,
      IPC_CHECKLIST_TEMPLATE_SOLUTION_ID: env.IPC_CHECKLIST_TEMPLATE_SOLUTION_ID ?? env.ELEVATE_PF_OBSERVATION_SOLUTION_ID,
    });
    const gateway = ElevateAdminGateway.fromConfig(cfg);
    if ('missing' in gateway) throw new Error(`workflow ELEVATE settings missing: ${gateway.missing.join(', ')}`);
    const ctx = createContext({ profile: cfg.IPC_PROFILE, demoMode: true, elevate: gateway, codePrefix: `PFI${TS % 1e7}-` });
    ctxRef.ctx = ctx;
    const { app } = createWorkflowApp({
      logger: createLogger('us1-int', 'silent'), jwt: { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' },
      readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const workflowUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    adaptersConn = await mongoose.createConnection(mongo.rs.getUri(), { dbName: `ipc_us1_int_${TS}`, autoIndex: false }).asPromise();
    const { up } = (await import('../../services/adapters/migrations/20261123000200-adapters-import-collections.cjs')) as unknown as { up(db: unknown): Promise<void> };
    await up(adaptersConn.db);
    imports = new ImportService({
      models: createImportModels(adaptersConn),
      elevate: ElevateImportClient.create(
        { userUrl: env.ELEVATE_USER_URL!, entityUrl: env.ELEVATE_ENTITY_URL!, internalAccessToken: env.ELEVATE_INTERNAL_ACCESS_TOKEN!, entityAdminToken: env.ELEVATE_ADMIN_TOKEN_ENTITY!, tenantCode: env.ELEVATE_TENANT_CODE || 'default', origin: env.ELEVATE_ORIGIN || 'http://localhost' },
        { admin: { identifier: env.ELEVATE_ADMIN_EMAIL!, password: env.ELEVATE_ADMIN_PASSWORD! }, orgAdmin: { identifier: env.ELEVATE_ORG_ADMIN_EMAIL!, password: env.ELEVATE_ORG_ADMIN_PASSWORD! } },
      ),
      registerFor: (userId) => new HttpRegisterClient(workflowUrl, SECRET, { userId, role: 'STATE_ADMIN' }),
      initialPassword: env.DEMO_USER_PASSWORD!,
      logger: createLogger('us1-int', 'silent'),
    });
    elevate = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-us1-int' });
  }, 120_000);

  afterAll(async () => {
    await elevate?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await adaptersConn?.close();
    await mongo?.stop();
  });

  it('facility import: hospitals and wards exist in ELEVATE with the facility code as externalId, mapped, and in the register', async () => {
    const job = await runImport('facility', FACILITY_CSV);
    expect(job.rowErrors).toEqual([]);
    expect(job).toMatchObject({ status: 'succeeded', counts: { rows: 6, created: 8, failed: 0 } });
    const ha = await elevate.entity.findByExternalId(`${P}-HA`);
    const w4 = await elevate.entity.findByExternalId(`${P}-HA-W4`);
    expect(ha?.entityType).toBe('hospital');
    expect(w4?.entityType).toBe('ward');
    const org = (await elevate.user.login(env.ELEVATE_ORG_ADMIN_EMAIL!, env.ELEVATE_ORG_ADMIN_PASSWORD!)).access_token;
    expect((await elevate.entity.subEntities(org, ha!._id, 'ward')).map((e) => e._id)).toContain(w4!._id);
    const page = await ctxRef.ctx!.admin.listFacilities({ role: 'STATE_ADMIN', assignments: [{ role: 'STATE_ADMIN', scope: { level: 'state' } }] }, { limit: 10 });
    const fa = page.items.find((f) => f.facilityCode === `${P}-HA`)!;
    expect(fa).toMatchObject({ elevateEntityId: ha!._id, districtCode: `${P}-D1`, location: { lat: 12.97, lng: 77.59 } });
    expect(fa.wards.map((w) => w.wardCode).sort()).toEqual([`${P}-HA-W1`, `${P}-HA-W2`, `${P}-HA-W4`]);
    // re-import is an upsert by code: nothing new in ELEVATE or the register
    const again = await runImport('facility', FACILITY_CSV);
    expect(again.counts).toMatchObject({ created: 0, updated: 0, failed: 0 });
  }, 120_000);

  it('HR import: named users exist in ELEVATE with a role, and each has a programme scope; mentors via request + approval', async () => {
    const job = await runImport('hr', HR_CSV(STAFF));
    expect(job.rowErrors).toEqual([]);
    expect(job).toMatchObject({ status: 'succeeded', counts: { rows: 4, created: 4, failed: 0 } });
    const sup = await elevate.user.login(mail('sup'), env.DEMO_USER_PASSWORD!);
    expect(sup.user.name).toBe('Asha Supervisor');
    expect(sup.user.organizations?.[0]?.roles?.map((r) => r.title)).toContain('user');
    const mentor = await elevate.user.login(mail('mentor'), env.DEMO_USER_PASSWORD!);
    expect(mentor.user.organizations?.[0]?.roles?.map((r) => r.title)).toContain('mentor');
    const eff = await ctxRef.ctx!.scope.effective(String(sup.user.id));
    expect(eff.assignments).toHaveLength(1);
    expect(eff.assignments[0]).toMatchObject({ role: 'WARD_SUPERVISOR', source: 'hr_import', scope: { level: 'wards' } });
    const dqm = await elevate.user.login(mail('dqm'), env.DEMO_USER_PASSWORD!);
    expect((await ctxRef.ctx!.scope.effective(String(dqm.user.id))).assignments[0]!.scope).toEqual({ level: 'district', districtCode: `${P}-D1` });
    const again = await runImport('hr', HR_CSV(STAFF));
    expect(again.counts).toMatchObject({ created: 0, failed: 0 });
  }, 180_000);

  it('a leaver is deactivated in ELEVATE, their scope ends and their open tasks need reassignment', async () => {
    const sup = await elevate.user.login(mail('sup'), env.DEMO_USER_PASSWORD!);
    const userId = String(sup.user.id);
    await TaskModel.create({
      planId: new Types.ObjectId(), taskKey: 't1', title: { en: 'Fit hand rub' }, riskLevel: 'critical', ownerUserId: userId, dueAt: new Date(),
      evidenceRule: { photoRequired: true, minPhotos: 1 }, state: 'IN_PROGRESS', syncState: 'in_sync',
    });
    const job = await runImport('hr', HR_CSV([STAFF[0]!.replace(',active,', ',left,')]));
    expect(job.rowErrors).toEqual([]);
    expect(job.counts).toMatchObject({ deactivated: 1, tasksNeedingReassignment: 1, failed: 0 });
    await expect(elevate.user.login(mail('sup'), env.DEMO_USER_PASSWORD!)).rejects.toMatchObject({ status: 400 });
    expect((await ctxRef.ctx!.scope.effective(userId)).assignments).toEqual([]);
    expect((await ScopeAssignmentModel.findOne({ userId }).lean())!.validTo).toBeInstanceOf(Date);
    expect((await ctxRef.ctx!.admin.tasksNeedingReassignment()).map((t) => t.ownerUserId)).toEqual([userId]);
  }, 120_000);

  it.skipIf(!(env.IPC_CHECKLIST_TEMPLATE_SOLUTION_ID ?? env.ELEVATE_PF_OBSERVATION_SOLUTION_ID))(
    'checklist v1 from the template and v2 from v1 via importFromSolution + updateSolution(ward); a cycle gets its own plan solution',
    async () => {
      const ctx = ctxRef.ctx!;
      const actor = { userId: ADMIN_ACTOR, role: 'STATE_ADMIN' as const };
      const sections = [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: [] }];
      const questions = [{ questionKey: 'HH_1', sectionKey: 'hand_hygiene', text: { en: 'Hand rub at every bed' }, riskLevel: 'critical' as const, passMark: 1, maxScore: 1, elevateQuestionExternalId: 'IPC_Q1' }];
      const d1 = await ctx.catalogue.createDraft({ checklistCode: 'IPC-WARD', sections, questions }, actor);
      const v1 = await ctx.catalogue.publish(d1.id, d1.v, actor);
      expect(v1.elevateSolutionId).toMatch(/^[a-f0-9]{24}$/);
      const d2 = await ctx.catalogue.createDraft({ checklistCode: d1.checklistCode, basedOnVersionId: v1.id }, actor);
      const v2 = await ctx.catalogue.publish(d2.id, d2.v, actor);
      expect(v2.elevateSolutionId).not.toBe(v1.elevateSolutionId);
      // ELEVATE holds the copy; the org admin can read it as a ward-type solution
      const org = (await elevate.user.login(env.ELEVATE_ORG_ADMIN_EMAIL!, env.ELEVATE_ORG_ADMIN_PASSWORD!)).access_token;
      expect((await elevate.samiksha.solutionDetails(org, v2.elevateSolutionId!)).solution._id).toBe(v2.elevateSolutionId);
      const old = await ctx.catalogue.get(v1.id, { includeDrafts: false });
      expect(old.graceUntil).toBeDefined();
      expect(old.questions[0]!.questionKey).toBe('HH_1');

      const cycle = await ctx.admin.createCycle({
        code: `2099-C${TS % 1000}`, startsAt: new Date('2099-01-01T00:00:00Z'), endsAt: new Date('2099-06-30T00:00:00Z'), targetDates: { baselineBy: new Date('2099-02-01T00:00:00Z') },
      }, actor);
      expect(cycle.elevateSolutionIds.plan).toMatch(/^[a-f0-9]{24}$/);
      expect(cycle.elevateSolutionIds.observation).toMatch(/^[a-f0-9]{24}$/);
      expect((await ctx.ledger.verify()).ok).toBe(true);
    },
    180_000,
  );

  it('the service JWT used by the adapters is the one workflow expects', async () => {
    expect(await signServiceJwt({ secret: SECRET, issuer: 'ipc-adapters', audience: 'ipc-workflow', sub: 'ipc-adapters' })).toMatch(/^eyJ/);
  });
});

it.skipIf(!skipReason)('US1 setup integration tests skipped (ELEVATE or seed accounts missing)', () => {
  expect(skipReason).toBeTruthy();
});
