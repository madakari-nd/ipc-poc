import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { SignJWT } from 'jose';
import { createLogger } from '@ipc/platform';
import { ElevateError, type Entity, type LoginResult } from '@ipc/elevate-client';
import { createApp } from '../src/app.js';
import { parseCsv, CsvError } from '../src/importers/csv.js';
import { LOCATION_SUBSTITUTION, runFacilityImport } from '../src/importers/facility.importer.js';
import { elevateName, runHrImport } from '../src/importers/hr.importer.js';
import { ImportService } from '../src/importers/import.service.js';
import { createImportModels, type ImportModels } from '../src/importers/job.js';
import { RegisterRowError, type ElevateImportPort, type RegisterPort } from '../src/importers/ports.js';

/** In-memory stand-in for the ELEVATE client interface (unit tests only; Constitution I). */
class FakeElevate implements ElevateImportPort {
  entities = new Map<string, { _id: string; type: string; name: string; children: string[] }>();
  users = new Map<string, { id: number; name: string; password: string; active: boolean; roles: string[] }>();
  requests: { id: number; email: string; status: string }[] = [];
  calls: string[] = [];
  private seq = 0;
  private oid = () => (++this.seq).toString(16).padStart(24, '0');

  async findEntity(externalId: string) {
    const e = this.entities.get(externalId);
    if (!e) return undefined;
    const parent = e.type === 'hospital' ? { groups: { ward: e.children } } : {};
    return { _id: e._id, metaInformation: { externalId, name: e.name }, ...parent } as Entity;
  }
  async bulkCreateEntities(type: 'hospital' | 'ward', rows: { externalId: string; name: string }[]) {
    this.calls.push(`bulkCreate:${type}:${rows.length}`);
    if (rows.some((r) => this.entities.has(r.externalId))) throw new ElevateError('entity', 'entities.bulkCreate', 400, undefined, 'E11000 duplicate key');
    return rows.map((r) => {
      const _id = this.oid();
      this.entities.set(r.externalId, { _id, type, name: r.name, children: [] });
      return { externalId: r.externalId, name: r.name, _SYSTEM_ID: _id, status: 'SUCCESS' };
    });
  }
  async mapChildren(pairs: { parentId: string; childId: string }[]) {
    this.calls.push(`map:${pairs.length}`);
    for (const p of pairs) [...this.entities.values()].find((e) => e._id === p.parentId)!.children.push(p.childId);
  }
  async renameEntity(_id: string, externalId: string, name: string) {
    this.calls.push('rename');
    this.entities.get(externalId)!.name = name;
  }
  private result(email: string): LoginResult {
    const u = this.users.get(email)!;
    return { access_token: `tok-${u.id}`, refresh_token: 'r', user: { id: u.id, name: u.name } } as LoginResult;
  }
  async createAccount(i: { name: string; email: string; password: string }) {
    this.calls.push('createAccount');
    if (!/^[A-Za-z ]+$/.test(i.name)) throw new ElevateError('user', 'account.create', 422, 'CLIENT_ERROR', 'This field can only contain alphabets');
    if (this.users.has(i.email)) throw new ElevateError('user', 'account.create', 406, 'CLIENT_ERROR', 'User already exists.');
    this.users.set(i.email, { id: 100 + this.users.size, name: i.name, password: i.password, active: true, roles: ['mentee'] });
    return this.result(i.email);
  }
  async login(email: string, password: string) {
    const u = this.users.get(email);
    if (!u || !u.active || u.password !== password) throw new ElevateError('user', 'account.login', 400, 'CLIENT_ERROR', 'Invalid identifier or password');
    return this.result(email);
  }
  async assignRole(userId: number, role: string) {
    this.calls.push(`assignRole:${userId}:${role}`);
    [...this.users.values()].find((u) => u.id === userId)!.roles.push(role);
  }
  async requestRole(token: string, role: string) {
    const id = Number(token.slice(4));
    const email = [...this.users.entries()].find(([, u]) => u.id === id)![0];
    const existing = this.requests.find((r) => r.email === email);
    if (existing) return existing;
    this.calls.push(`requestRole:${role}`);
    const r = { id: this.requests.length + 1, email, status: 'REQUESTED' };
    this.requests.push(r);
    return r;
  }
  async approveRoleRequest(id: number) {
    this.calls.push(`approve:${id}`);
    const r = this.requests.find((x) => x.id === id)!;
    r.status = 'APPROVED';
    this.users.get(r.email)!.roles.push('mentor');
  }
  async deactivate(userId: number) {
    this.calls.push(`deactivate:${userId}`);
    [...this.users.values()].find((u) => u.id === userId)!.active = false;
  }
}

/** Register stand-in that mirrors workflow's upsert / scope semantics closely enough for the importer. */
class FakeRegister implements RegisterPort {
  facilities = new Map<string, { row: Record<string, unknown>; wards: Set<string> }>();
  staff = new Map<string, Record<string, unknown>>();
  openTasks = new Map<string, number>();
  ledger: string[] = [];
  async upsertFacility(row: Record<string, unknown>) {
    const code = String(row.facilityCode);
    const prev = this.facilities.get(code);
    const wards = (row.wards as { wardCode: string }[]).map((w) => {
      const created = !prev?.wards.has(w.wardCode);
      return { wardCode: w.wardCode, wardId: `w-${w.wardCode}`, created, changed: created };
    });
    const facility = { ...row };
    delete facility.wards;
    const changed = !prev || JSON.stringify(prev.row) !== JSON.stringify(facility);
    this.facilities.set(code, { row: facility, wards: new Set([...(prev?.wards ?? []), ...wards.map((w) => w.wardCode)]) });
    return { facilityId: `f-${code}`, created: !prev, changed, wards };
  }
  async applyStaff(row: Record<string, unknown>) {
    const id = String(row.userId);
    const scope = row.scope as { facilityCode?: string };
    if (scope.facilityCode && !this.facilities.has(scope.facilityCode)) throw new RegisterRowError(422, 'VALIDATION_FAILED', `Unknown facility code ${scope.facilityCode}`);
    const prev = this.staff.get(id);
    this.staff.set(id, row);
    if (row.status === 'left') return { outcome: 'deactivated' as const, assignmentIds: [], tasksNeedingReassignment: this.openTasks.get(id) ?? 0 };
    const outcome = !prev ? 'created' : JSON.stringify(prev.scope) === JSON.stringify(row.scope) ? 'unchanged' : 'updated';
    return { outcome: outcome as 'created' | 'unchanged' | 'updated', assignmentIds: ['a1'], tasksNeedingReassignment: 0 };
  }
  async appendLedger(e: { action: string }) {
    this.ledger.push(e.action);
  }
}

const require = createRequire(import.meta.url);
const migration = require('../migrations/20261123000200-adapters-import-collections.cjs') as { up(db: unknown): Promise<void>; down(db: unknown): Promise<void> };

let server: MongoMemoryServer;
let conn: Connection;
let models: ImportModels;
let elevate: FakeElevate;
let register: FakeRegister;
const PASSWORD = 'Initial@12345';

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  conn = await mongoose.createConnection(server.getUri(), { dbName: 'ipc_test', autoIndex: false, autoCreate: false }).asPromise();
  await migration.up(conn.db);
  models = createImportModels(conn);
}, 120_000);
afterAll(async () => {
  await conn.close();
  await server.stop();
});
beforeEach(async () => {
  await models.Job.deleteMany({});
  await models.Staff.deleteMany({});
  elevate = new FakeElevate();
  register = new FakeRegister();
});

const FACILITIES = [
  'Facility Code,Facility Name,District Code,Level,Lat,Lng,Status,Ward Code,Ward Name,Ward Type,Ward Active',
  'T-HA,Hospital A,T-D1,district,12.97,77.59,active,T-HA-W1,Ward 1,general,true',
  'T-HA,Hospital A,T-D1,district,12.97,77.59,active,T-HA-W4,Ward 4,ICU,true',
  'T-HB,Hospital B,T-D2,district,13.10,77.60,active,T-HB-W1,Ward 1,general,yes',
].join('\n');

const HR = (rows: string[]) => ['staff_id,name,email,role,status,district_code,facility_code,ward_codes', ...rows].join('\n');

describe('CSV parsing', () => {
  it('normalises headers, trims cells and numbers data rows from 1', () => {
    const rows = parseCsv('﻿ Staff ID ,Name\n  s1 , Asha \n\n s2,Ravi', ['staff_id', 'name']);
    expect(rows).toEqual([{ row: 1, cells: { staff_id: 's1', name: 'Asha' } }, { row: 2, cells: { staff_id: 's2', name: 'Ravi' } }]);
  });
  it('names missing columns and refuses files over 5 MB', () => {
    expect(() => parseCsv('a,b\n1,2', ['staff_id'])).toThrow(/Missing column\(s\): staff_id/);
    expect(() => parseCsv('x'.repeat(5 * 1024 * 1024 + 1), [])).toThrow(CsvError);
  });
});

describe('facility importer (T069)', () => {
  it('creates hospitals and wards in ELEVATE (bulkCreate + mapping), then upserts the register with the location', async () => {
    const r = await runFacilityImport(FACILITIES, { elevate, register, dryRun: false });
    expect(r.status()).toBe('succeeded');
    expect(r.counts).toMatchObject({ rows: 3, created: 5, updated: 0, failed: 0 });
    expect(elevate.calls).toEqual(['bulkCreate:hospital:2', 'bulkCreate:ward:3', 'map:3']);
    expect(register.facilities.get('T-HA')!.row).toMatchObject({ location: { lat: 12.97, lng: 77.59 }, districtCode: 'T-D1', elevateEntityId: elevate.entities.get('T-HA')!._id });
    expect([...r.substitutions]).toContain(LOCATION_SUBSTITUTION);
  });

  it('is idempotent by facility code: a re-run creates nothing in ELEVATE and updates only what changed', async () => {
    await runFacilityImport(FACILITIES, { elevate, register, dryRun: false });
    elevate.calls = [];
    const again = await runFacilityImport(FACILITIES, { elevate, register, dryRun: false });
    expect(again.counts).toMatchObject({ created: 0, updated: 0, failed: 0 });
    expect(elevate.calls).toEqual(['map:0']);
    const renamed = await runFacilityImport(FACILITIES.replace(/Hospital B/g, 'Hospital B North'), { elevate, register, dryRun: false });
    expect(renamed.counts).toMatchObject({ created: 0, updated: 1 });
    expect(elevate.calls).toContain('rename');
  });

  it('reports bad rows and keeps the good ones; dry run validates only', async () => {
    const csv = `${FACILITIES}\nT-HC,Hospital C,T-D2,clinic,13,77,active,,,,\nT-HA,Hospital A,T-D1,district,12.97,77.59,active,T-HA-W1,Ward 1,general,true\nT-HD,Hospital D,T-D2,district,95,77,active,,,,`;
    const dry = await runFacilityImport(csv, { elevate, register, dryRun: true });
    expect(dry.rowErrors.map((e) => [e.row, e.code])).toEqual([[4, 'VALIDATION_FAILED'], [5, 'DUPLICATE_WARD'], [6, 'VALIDATION_FAILED']]);
    expect(elevate.calls).toEqual([]);
    const real = await runFacilityImport(csv, { elevate, register, dryRun: false });
    expect(real.status()).toBe('partially_succeeded');
    expect(register.facilities.size).toBe(2);
  });

  it('a file that is not a facility master fails as a whole', async () => {
    const r = await runFacilityImport('foo,bar\n1,2', { elevate, register, dryRun: false });
    expect(r.status()).toBe('failed');
    expect(r.rowErrors[0]!.code).toBe('INVALID_FILE');
  });
});

describe('HR importer (T070)', () => {
  const deps = () => ({ elevate, register, staff: models.Staff, initialPassword: PASSWORD, dryRun: false });
  beforeEach(async () => {
    await runFacilityImport(FACILITIES, { elevate, register, dryRun: false });
    elevate.calls = [];
  });

  it('creates users one at a time with the ELEVATE user role, and mentors via role request + approval', async () => {
    const r = await runHrImport(HR([
      'S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,active,,T-HA,T-HA-W4',
      'S2,Dr. Meera K2,meera@example.org,mentor,,,,',
      'S3,Ravi,ravi@example.org,IPC_OFFICER,active,,T-HA,',
    ]), deps());
    expect(r.status()).toBe('succeeded');
    expect(r.counts).toMatchObject({ rows: 3, created: 3, failed: 0 });
    expect(elevate.users.get('meera@example.org')!.name).toBe('Dr Meera K');
    expect(elevate.users.get('meera@example.org')!.roles).toContain('mentor');
    expect(elevate.calls.filter((c) => c.startsWith('assignRole'))).toHaveLength(2);
    expect(elevate.calls).toContain('requestRole:mentor');
    expect(register.staff.get(String(elevate.users.get('asha@example.org')!.id))).toMatchObject({
      role: 'WARD_SUPERVISOR', scope: { level: 'wards', facilityCode: 'T-HA', wardCodes: ['T-HA-W4'] },
    });
    expect((await models.Staff.findOne({ staffId: 'S2' }).lean())).toMatchObject({ elevateRole: 'mentor', status: 'active' });
  });

  it('is an upsert by staff id: a re-run makes no ELEVATE call; a changed ward updates the scope', async () => {
    const rows = ['S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,active,,T-HA,T-HA-W4'];
    await runHrImport(HR(rows), deps());
    elevate.calls = [];
    const again = await runHrImport(HR(rows), deps());
    expect(again.counts).toMatchObject({ created: 0, updated: 0, failed: 0 });
    expect(elevate.calls).toEqual([]);
    const moved = await runHrImport(HR(['S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,active,,T-HA,T-HA-W1;T-HA-W4']), deps());
    expect(moved.counts.updated).toBe(1);
  });

  it('adopts an existing ELEVATE account when the first password still works', async () => {
    await elevate.createAccount({ name: 'Asha Rao', email: 'asha@example.org', password: PASSWORD });
    const r = await runHrImport(HR(['S1,Asha Rao,asha@example.org,FRONTLINE,active,,T-HA,']), deps());
    expect(r.counts).toMatchObject({ created: 1, failed: 0 });
    elevate.users.get('asha@example.org')!.password = 'changed';
    await models.Staff.deleteMany({});
    const r2 = await runHrImport(HR(['S1,Asha Rao,asha@example.org,FRONTLINE,active,,T-HA,']), deps());
    expect(r2.rowErrors[0]!.code).toBe('USER_EXISTS');
  });

  it('deactivates leavers in ELEVATE, ends their scope and counts their open tasks for reassignment', async () => {
    await runHrImport(HR(['S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,active,,T-HA,T-HA-W4']), deps());
    const userId = elevate.users.get('asha@example.org')!.id;
    register.openTasks.set(String(userId), 2);
    const r = await runHrImport(HR(['S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,left,,T-HA,T-HA-W4']), deps());
    expect(r.counts).toMatchObject({ deactivated: 1, tasksNeedingReassignment: 2, failed: 0 });
    expect(elevate.users.get('asha@example.org')!.active).toBe(false);
    expect(register.staff.get(String(userId))).toMatchObject({ status: 'left' });
    elevate.calls = [];
    const again = await runHrImport(HR(['S1,Asha Rao,asha@example.org,WARD_SUPERVISOR,left,,T-HA,T-HA-W4']), deps());
    expect(elevate.calls).toEqual([]);
    expect(again.counts.failed).toBe(0);
  });

  it('reports row errors: unknown leaver, missing scope fields, unknown facility, bad role, duplicates', async () => {
    const r = await runHrImport(HR([
      'S9,Gone,gone@example.org,FRONTLINE,left,,,',
      'S2,Kiran,kiran@example.org,DISTRICT_QM,active,,,',
      'S3,Lata,lata@example.org,IPC_OFFICER,active,,NOPE,',
      'S4,Om,om@example.org,CEO,active,,,',
      'S5,Uma,uma@example.org,FRONTLINE,active,,T-HA,',
      'S5,Uma,uma@example.org,FRONTLINE,active,,T-HA,',
    ]), deps());
    expect(r.rowErrors.map((e) => [e.row, e.code])).toEqual([
      [1, 'UNKNOWN_STAFF'], [2, 'VALIDATION_FAILED'], [3, 'VALIDATION_FAILED'], [4, 'VALIDATION_FAILED'], [6, 'DUPLICATE_STAFF'],
    ]);
    expect(r.status()).toBe('partially_succeeded');
  });

  it('keeps ELEVATE names to letters and spaces', () => {
    expect(elevateName('Dr. Anil-Kumar 3rd')).toBe('Dr Anil Kumar rd');
  });
});

describe('import jobs over /internal/imports (createImport / getImport)', () => {
  const SECRET = 'adapters-test-secret-0123456789abcdef';
  const token = (role: string, aud = 'ipc-adapters') => new SignJWT({ act: { userId: 'admin-1', role } })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer('ipc-edge').setAudience(aud).setSubject('ipc-edge').setIssuedAt().setExpirationTime('60s')
    .sign(new TextEncoder().encode(SECRET));

  it('accepts a job (202), runs it in the background and reports status, counts and substitutions', async () => {
    const service = new ImportService({ models, elevate, registerFor: () => register, initialPassword: PASSWORD, logger: createLogger('t', 'silent') });
    const { app } = createApp({ logger: createLogger('t', 'silent'), readiness: {}, imports: { service, secret: SECRET } });
    const res = await request(app).post('/internal/imports').set('Authorization', `Bearer ${await token('STATE_ADMIN')}`)
      .send({ kind: 'facility', csv: FACILITIES }).expect(202);
    expect(res.body).toMatchObject({ kind: 'facility', status: 'queued', dryRun: false });
    expect(res.headers.location).toBe(`/ipc/v1/admin/imports/${res.body.id}`);
    await service.idle();
    const job = await request(app).get(`/internal/imports/${res.body.id}`).set('Authorization', `Bearer ${await token('STATE_ADMIN')}`).expect(200);
    expect(job.body).toMatchObject({ status: 'succeeded', counts: { rows: 3, created: 5, failed: 0 } });
    expect(job.body.substitutions).toContain(LOCATION_SUBSTITUTION);
    expect(job.body.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(register.ledger).toEqual(['import.completed']);
  });

  it('refuses other roles, other audiences and a missing token; unknown jobs are 404', async () => {
    const service = new ImportService({ models, elevate, registerFor: () => register, initialPassword: PASSWORD, logger: createLogger('t', 'silent') });
    const { app } = createApp({ logger: createLogger('t', 'silent'), readiness: {}, imports: { service, secret: SECRET } });
    expect((await request(app).post('/internal/imports').set('Authorization', `Bearer ${await token('IPC_OFFICER')}`).send({ kind: 'hr', csv: 'x' }).expect(403)).body.code).toBe('ROLE_DENIED');
    await request(app).post('/internal/imports').set('Authorization', `Bearer ${await token('STATE_ADMIN', 'ipc-workflow')}`).send({ kind: 'hr', csv: 'x' }).expect(401);
    await request(app).get('/internal/imports/abc').expect(401);
    await request(app).get(`/internal/imports/${'a'.repeat(24)}`).set('Authorization', `Bearer ${await token('STATE_ADMIN')}`).expect(404);
    expect((await request(app).post('/internal/imports').set('Authorization', `Bearer ${await token('STATE_ADMIN')}`).send({ kind: 'pdf', csv: 'x' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it('answers 503 naming the missing settings when imports are not configured', async () => {
    const { app } = createApp({ logger: createLogger('t', 'silent'), readiness: {}, imports: { missing: ['ELEVATE_ADMIN_EMAIL'] } });
    const r = await request(app).post('/internal/imports').send({}).expect(503);
    expect(r.body.detail).toContain('ELEVATE_ADMIN_EMAIL');
  });

  it('the migration is reversible', async () => {
    await models.Job.deleteMany({});
    await models.Staff.deleteMany({});
    await migration.down(conn.db);
    expect((await conn.db!.listCollections().toArray()).map((c) => c.name)).not.toContain('import_jobs');
    await migration.up(conn.db);
  });
});
