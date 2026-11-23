/**
 * Through-the-Edge side of the security suite. `IPC_SECURITY_TARGET` picks the Edge under test:
 *
 * - `inprocess` (default): the real Edge app (`createApps`) on a real MongoDB (mongodb-memory-server),
 *   with an in-memory S3 and a workflow stub that serves the scopes of two hospitals (the Edge's
 *   own test fixtures: Hospital A = officerA/frontA1/frontA2/supervisorA, Hospital B = officerB).
 * - `stack`: the dockerised stack at `EDGE_PUBLIC_URL` (default https://localhost), signing in with
 *   the real lab users. Ids of seeded fixtures come from `SEC_STACK_*`; a case whose fixture is not
 *   configured is reported as not run instead of passing silently.
 */
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { AppConfig } from '../../../services/edge/src/app.js';
import type { Actor } from '../../../services/edge/src/scope/types.js';
import type { LedgerAppend } from '../../../services/edge/src/workflow/workflow.client.js';
import { MongoRateLimitStore } from '../../../services/edge/src/middleware/ratelimit.js';
import { buildHarness } from '../../../services/edge/tests/helpers/app.js';
import { FakeWorkflow } from '../../../services/edge/tests/helpers/fakes.js';
import { ASSESS_A1, ASSESS_B1, FA, FB, TASK_A1, WA1, WB1 } from '../../../services/edge/tests/helpers/fixtures.js';
import { startDb } from '../../../services/edge/tests/helpers/mongo.js';
import { env, LAB } from './direct.js';

export type TargetName = 'inprocess' | 'stack';
export const TARGET: TargetName = process.env.IPC_SECURITY_TARGET === 'stack' ? 'stack' : 'inprocess';

/** Hospital A officer, Hospital B officer, two Hospital A frontline staff, a Hospital A ward supervisor. */
export type Persona = 'hospA' | 'hospB' | 'frontA1' | 'frontA2' | 'supervisorA';

export interface Session {
  cookie: string;
  csrf: string;
  setCookie: string;
  get(path: string): request.Test;
  /** Write with session, CSRF and a fresh Idempotency-Key unless one is given in `headers`. */
  write(method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, headers?: Record<string, string>): request.Test;
}

export interface Ids { facilityA: string; facilityB: string; wardA: string; wardB: string; taskA1: string; assessA: string; assessB: string }

export interface Target {
  name: TargetName;
  /** Set when the target cannot run at all (e.g. stack not up). */
  skip?: string;
  ids: Ids;
  /** Bare request with no session. */
  http(method: 'get' | 'post' | 'put' | 'delete', path: string): request.Test;
  login(p: Persona, client?: 'web' | 'field'): Promise<Session>;
  /** A confirmed evidence item uploaded by Hospital A frontline staff on task A1. */
  evidenceA(): Promise<{ id: string; v: number }>;
  /** In-process only: ledger appends the Edge sent to workflow, and acting users it forwarded. */
  ledger?: LedgerAppend[];
  forwardedActors?: Actor[];
  /** In-process only: evidence items stored by the Edge. */
  evidenceCount?(): Promise<number>;
  close(): Promise<void>;
}

/** A case that cannot run on this target; the report shows it as not run. */
export class NotRunnable extends Error {}

const PHOTO = Buffer.from(`security-suite-photo-${randomUUID()}`);
export const photoSha = createHash('sha256').update(PHOTO).digest('hex');

export const intentBody = (o: Record<string, unknown> = {}) => ({
  sha256: photoSha,
  sizeBytes: PHOTO.length,
  mime: 'image/jpeg',
  capturedAt: new Date(Date.now() - 60_000).toISOString(),
  gps: { lat: 12.97, lng: 77.59, accuracyM: 8 },
  gpsUnavailable: false,
  deviceId: randomUUID(),
  ...o,
});

/** Workflow stub that also remembers which acting user the Edge forwarded (V3). */
class RecordingWorkflow extends FakeWorkflow {
  actors: Actor[] = [];
  override async listFacilities(actor: Actor) {
    this.actors.push(actor);
    return super.listFacilities(actor);
  }
  override async getHome(actor: Actor) {
    this.actors.push(actor);
    return super.getHome(actor);
  }
  override async getResource(actor: Actor, path: string) {
    this.actors.push(actor);
    return super.getResource(actor, path);
  }
}

const IN_PROCESS_USER: Record<Persona, string> = {
  hospA: 'officerA',
  hospB: 'officerB',
  frontA1: 'frontA1',
  frontA2: 'frontA2',
  supervisorA: 'supervisorA',
};

function session(http: () => ReturnType<typeof request>, cookie: string, csrf: string, setCookie: string, tls: boolean): Session {
  const base = (t: request.Test) => (tls ? t.disableTLSCerts() : t);
  const agent = http();
  return {
    cookie,
    csrf,
    setCookie,
    get: (path) => base(agent.get(path).set('Cookie', cookie)),
    write: (method, path, body, headers = {}) => {
      const t = base(agent[method](path).set('Cookie', cookie).set('X-CSRF-Token', csrf));
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'idempotency-key')) t.set('Idempotency-Key', randomUUID());
      for (const [k, v] of Object.entries(headers)) t.set(k, v);
      return body === undefined ? t : t.send(body as object);
    },
  };
}

async function inProcess(o: { config?: Partial<AppConfig>; mongoRateLimit?: boolean }): Promise<Target> {
  const db = await startDb();
  const workflow = new RecordingWorkflow();
  const h = buildHarness(db, {
    workflow,
    config: o.config,
    ...(o.mongoRateLimit ? { rateLimitStore: (p: string) => new MongoRateLimitStore(db.conn, p) } : {}),
  });
  const http = () => request(h.app);
  const t: Target = {
    name: 'inprocess',
    ids: { facilityA: FA, facilityB: FB, wardA: WA1, wardB: WB1, taskA1: TASK_A1, assessA: ASSESS_A1, assessB: ASSESS_B1 },
    http: (m, path) => http()[m](path),
    async login(p, client = 'web') {
      const res = await http()
        .post('/ipc/v1/auth/login')
        .send({ identifier: IN_PROCESS_USER[p], password: 'pw', client, ...(client === 'field' ? { deviceId: randomUUID() } : {}) });
      if (res.status !== 200) throw new Error(`login ${p} failed: ${res.status}`);
      const setCookie = String(res.headers['set-cookie']?.[0] ?? '');
      return session(http, setCookie.split(';')[0]!, String(res.body.csrfToken), setCookie, false);
    },
    async evidenceA() {
      const front = await t.login('frontA1', 'field');
      const r = await front.write('post', '/ipc/v1/evidence/intents', intentBody({ wardId: WA1, link: { type: 'task', id: TASK_A1 } }));
      if (r.status !== 201) throw new Error(`evidence intent failed: ${r.status} ${JSON.stringify(r.body)}`);
      const key = (await db.models.Evidence.findById(r.body.evidence.id).lean())!.objectKey;
      h.store.put(key, PHOTO, 'image/jpeg');
      const c = await front.write('post', `/ipc/v1/evidence/${r.body.evidence.id}/confirmation`);
      if (c.status !== 200) throw new Error(`evidence confirm failed: ${c.status}`);
      return { id: String(r.body.evidence.id), v: Number(c.body.v) };
    },
    ledger: workflow.ledger,
    forwardedActors: workflow.actors,
    evidenceCount: () => db.models.Evidence.countDocuments(),
    close: () => db.stop(),
  };
  return t;
}

async function stack(): Promise<Target> {
  const base = (process.env.EDGE_PUBLIC_URL ?? 'https://localhost').replace(/\/+$/, '');
  const tls = base.startsWith('https:');
  let skip: string | undefined;
  try {
    const r = await request(base).get('/healthz').disableTLSCerts().timeout(4000);
    if (r.status !== 200) skip = `Edge at ${base} answered /healthz with ${r.status}`;
  } catch (e) {
    skip = `Edge stack not reachable at ${base}: ${(e as Error).message}`;
  }
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new NotRunnable(`${k} not set for the stack target`);
    return v;
  };
  const creds = (p: Persona): [string, string] => {
    if (p === 'hospA') return [LAB.hospA, LAB.password];
    if (p === 'hospB') return [LAB.hospB, LAB.password];
    return [need(`SEC_STACK_${p.toUpperCase()}_EMAIL`), process.env.SEC_STACK_PASSWORD ?? env.DEMO_USER_PASSWORD ?? ''];
  };
  const http = () => request(base);
  const lazyIds = new Proxy({} as Ids, {
    get: (_o, k: string) => need(`SEC_STACK_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`),
  });
  const t: Target = {
    name: 'stack',
    ...(skip ? { skip } : {}),
    ids: lazyIds,
    http: (m, path) => http()[m](path).disableTLSCerts(),
    async login(p, client = 'web') {
      const [identifier, password] = creds(p);
      const res = await http()
        .post('/ipc/v1/auth/login')
        .disableTLSCerts()
        .send({ identifier, password, client, ...(client === 'field' ? { deviceId: randomUUID() } : {}) });
      if (res.status !== 200) throw new NotRunnable(`stack login for ${p} failed with ${res.status} (scope assignment seeded?)`);
      const setCookie = String(res.headers['set-cookie']?.[0] ?? '');
      return session(http, setCookie.split(';')[0]!, String(res.body.csrfToken), setCookie, tls);
    },
    async evidenceA() {
      const front = await t.login('frontA1', 'field');
      const r = await front.write('post', '/ipc/v1/evidence/intents', intentBody({ wardId: t.ids.wardA, link: { type: 'task', id: t.ids.taskA1 } }));
      if (r.status !== 201) throw new NotRunnable(`stack evidence intent failed: ${r.status} ${r.body?.code ?? ''}`);
      const put = await fetch(r.body.upload.url, { method: 'PUT', headers: r.body.upload.headers, body: PHOTO });
      if (!put.ok) throw new NotRunnable(`stack evidence upload failed: ${put.status}`);
      const c = await front.write('post', `/ipc/v1/evidence/${r.body.evidence.id}/confirmation`);
      if (c.status !== 200) throw new NotRunnable(`stack evidence confirm failed: ${c.status}`);
      return { id: String(r.body.evidence.id), v: Number(c.body.v) };
    },
    close: async () => {},
  };
  return t;
}

export function openTarget(o: { config?: Partial<AppConfig>; mongoRateLimit?: boolean } = {}): Promise<Target> {
  return TARGET === 'stack' ? stack() : inProcess(o);
}
