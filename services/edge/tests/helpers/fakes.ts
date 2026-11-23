import { createHash } from 'node:crypto';
import type { Store, IncrementResponse, Options } from 'express-rate-limit';
import { Problem } from '@ipc/platform';
import type { ElevateLoginResult, ElevateUserApi } from '../../src/elevate/elevate.adapter.js';
import type { ObjectStore, StoredObject } from '../../src/evidence/object-store.js';
import type { Actor, EffectiveScopeResponse } from '../../src/scope/types.js';
import type { FacilityView, HomeSummary, LedgerAppend, WorkflowClient } from '../../src/workflow/workflow.client.js';
import { FACILITIES, RESOURCES, scopeOf } from './fixtures.js';

/** Workflow stub behind the WorkflowClient interface (unit tests only). */
export class FakeWorkflow implements WorkflowClient {
  ledger: LedgerAppend[] = [];
  scopeCalls = 0;
  down = false;
  home: HomeSummary = {
    role: 'IPC_OFFICER',
    programmeNow: '2026-11-23T00:00:00.000Z',
    cards: [
      { kind: 'assessments_due', count: 2 },
      { kind: 'my_tasks', count: 5 },
      { kind: 'checklist_drafts', count: 1 },
    ],
  };
  scopes: (userId: string) => EffectiveScopeResponse = scopeOf;

  async getEffectiveScope(userId: string) {
    this.scopeCalls++;
    if (this.down) throw new Problem(503, 'STORAGE_UNAVAILABLE', 'workflow down', { unavailable: ['workflow'] });
    return this.scopes(userId);
  }
  async appendLedger(entry: LedgerAppend) {
    this.ledger.push(entry);
  }
  async listFacilities(_actor: Actor): Promise<FacilityView[]> {
    return FACILITIES;
  }
  async getHome(actor: Actor) {
    return { ...this.home, role: actor.role };
  }
  async getResource(_actor: Actor, path: string) {
    return RESOURCES[path] ?? null;
  }
  async ping() {
    return !this.down;
  }
}

export const fakeJwt = (expSec: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;

/** ELEVATE user-service stub behind the edge adapter interface (unit tests only, Constitution I). */
export class FakeElevateUser implements ElevateUserApi {
  logins = 0;
  refreshes = 0;
  logouts = 0;
  down = false;
  accessExpSec = Math.floor(Date.now() / 1000) + 1800;

  async login(identifier: string, password: string): Promise<ElevateLoginResult> {
    this.logins++;
    if (this.down) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'down', { unavailable: ['elevate-user'] });
    if (password !== 'pw') throw Problem.unauthorized('Sign-in failed');
    return {
      accessToken: fakeJwt(this.accessExpSec),
      refreshToken: `refresh-${identifier}`,
      user: { id: identifier, name: `User ${identifier}`, preferredLanguage: 'hi' },
    };
  }
  async refresh(refreshToken: string) {
    this.refreshes++;
    return { accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 1800), refreshToken: `${refreshToken}-2` };
  }
  async logout() {
    this.logouts++;
  }
}

/** In-memory versioned bucket behind the ObjectStore interface. */
export class FakeObjectStore implements ObjectStore {
  versions = new Map<string, { body: Buffer; contentType: string }[]>();
  down = false;

  put(key: string, body: Buffer, contentType: string) {
    const v = this.versions.get(key) ?? [];
    v.push({ body, contentType });
    this.versions.set(key, v);
  }
  private latest(key: string) {
    return this.versions.get(key)?.at(-1);
  }
  private check() {
    if (this.down) throw new Error('minio down');
  }
  async presignPut(key: string, o: { contentType: string; ttlSec: number }) {
    this.check();
    return { url: `http://minio.test/bucket/${key}?X-Amz-Expires=${o.ttlSec}&X-Amz-Signature=put`, headers: { 'Content-Type': o.contentType } };
  }
  async presignGet(key: string, o: { ttlSec: number }) {
    this.check();
    return `http://minio.test/bucket/${key}?X-Amz-Expires=${o.ttlSec}&X-Amz-Signature=get`;
  }
  async head(key: string): Promise<StoredObject | null> {
    this.check();
    const l = this.latest(key);
    return l ? { size: l.body.length, contentType: l.contentType } : null;
  }
  async sha256(key: string) {
    this.check();
    return createHash('sha256').update(this.latest(key)!.body).digest('hex');
  }
  async deleteAllVersions(key: string) {
    this.check();
    const n = this.versions.get(key)?.length ?? 0;
    this.versions.delete(key);
    return n;
  }
  async ping() {
    return !this.down;
  }
}

/** Rate-limit store in memory (keeps the non-rate-limit suites independent of Mongo timing). */
export class MemoryStore implements Store {
  hits = new Map<string, number>();
  prefix: string;
  private windowMs = 60_000;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  init(o: Options) {
    this.windowMs = o.windowMs;
  }
  async increment(key: string): Promise<IncrementResponse> {
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return { totalHits: n, resetTime: new Date(Date.now() + this.windowMs) };
  }
  async decrement(key: string) {
    this.hits.set(key, (this.hits.get(key) ?? 1) - 1);
  }
  async resetKey(key: string) {
    this.hits.delete(key);
  }
}
