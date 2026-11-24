/**
 * T105 (US6) against the REAL local ELEVATE mentoring service (Constitution I, research E10/E11):
 * - availability: the seeded hand-hygiene mentor publishes daily office hours (once, idempotent);
 *   `isAvailable` (officer token) is true inside them and false for a mentor without any;
 * - `requestSessions/create` with the OFFICER's token, `list` as officer and as mentor, `accept`
 *   with the mentor credentials from `.env.test`, `list` shows ACCEPTED;
 * - workflow turns that ELEVATE fact into `accepted` (ledgered) and the mentor's facility scope
 *   follows (derived from accepted requests); the shortlist ranks {hand hygiene, Hindi} first.
 * `mentors/list` is not used (broken on this stack). Programme side: a throw-away database.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createElevateClients, ElevateConfigSchema, ElevateError, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { candidateSlotDays } from '../../services/workflow/src/domain/mentor-rank.js';
import { LedgerRecordModel, SupportRequestModel, WardModel } from '../../services/workflow/src/domain/models/index.js';
import { LedgerService } from '../../services/workflow/src/ledger/ledger.service.js';
import { ScopeService } from '../../services/workflow/src/services/scope.service.js';
import { elevateTitle, SupportService, type SupportActor } from '../../services/workflow/src/services/support.service.js';
import type { PlanService } from '../../services/workflow/src/services/plan.service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const ready = existsSync(envPath) && existsSync(statePath);
const env = ready ? readEnvFile(envPath) : {};
const state = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as { users: Record<string, { id: number; email: string }> }) : undefined;
const DB = `ipc_${PROFILE}_support_int_${Date.now()}`;
const SOURCE_DB = `ipc_${PROFILE}`;
const DAY = 86_400_000;
/** Without a status filter ELEVATE lists nothing on the mentor's side: ask for every status. */
const ALL = 'ACCEPTED,REQUESTED,REJECTED,EXPIRED';

/** Daily 09:00–17:00 IST office hours for the mentor, unless they already have an open slot. */
export async function ensureOfficeHours(c: ElevateClients, mentorToken: string, probeToken: string, mentorId: string): Promise<void> {
  const tomorrow = candidateSlotDays(new Date(Date.now() + DAY), { days: 1 })[0]!;
  const open = await Promise.all(tomorrow.map((s) => c.mentoring.isAvailable(probeToken, mentorId, s.getTime() / 1000, s.getTime() / 1000 + 3600)));
  if (open.some(Boolean)) return;
  const istMidnight = Math.floor((Date.now() + 19_800_000) / DAY) * DAY - 19_800_000;
  const start = (istMidnight - DAY + 9 * 3_600_000) / 1000;
  await c.mentoring.createAvailability(mentorToken, { eventName: 'IPC office hours', startTime: start, endTime: start + 8 * 3600, repeatUnit: 'DAY' });
}

/** A session slot inside office hours, 3–13 days ahead, unlikely to clash with an earlier run. */
const randomSlot = () => {
  const day = candidateSlotDays(new Date(Date.now() + (3 + Math.floor(Math.random() * 10)) * DAY), { days: 1, fromHour: 9, toHour: 16 })[0]!;
  const s = day[Math.floor(Math.random() * day.length)]!;
  return Math.floor(s.getTime() / 1000) + 15 * 60 * Math.floor(Math.random() * 4);
};

describe.skipIf(!ready || !env.DEMO_USER_PASSWORD || !env.ELEVATE_MENTOR_EMAIL)('US6 expert support with real ELEVATE mentoring (E10, E11)', () => {
  let c: ElevateClients;
  let officer: string;
  let mentor: string;
  const mentorId = String(state?.users['mentor-hh']?.id);
  const wasteId = String(state?.users['mentor-waste']?.id);
  const officerId = String(state?.users['officer-a']?.id);
  let requestId: string;
  let ledger: LedgerService;
  let support: SupportService;

  beforeAll(async () => {
    c = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-support-int-test' });
    officer = (await c.user.login(state!.users['officer-a']!.email, env.DEMO_USER_PASSWORD!)).access_token;
    mentor = (await c.user.login(env.ELEVATE_MENTOR_EMAIL!, env.ELEVATE_MENTOR_PASSWORD!)).access_token;
    await ensureOfficeHours(c, mentor, officer, mentorId);

    // Programme side: a throw-away DB with the seeded wards, scope assignments and mentor register.
    mongoose.set('autoIndex', false);
    await mongoose.connect(MONGO, { dbName: DB, serverSelectionTimeoutMS: 5000 });
    const db = mongoose.connection.db!;
    const src = mongoose.connection.getClient().db(SOURCE_DB);
    for (const name of ['wards', 'facilities', 'scope_assignments', 'mentor_profile_cache']) {
      const docs = await src.collection(name).find().toArray();
      await db.createCollection(name).catch(() => undefined);
      if (docs.length) await db.collection(name).insertMany(docs);
    }
    for (const name of ['support_requests', 'ledger', 'counters', 'plans', 'plan_revisions', 'tasks']) await db.createCollection(name).catch(() => undefined);
    await db.collection('ledger').createIndex({ seq: 1 }, { unique: true });
    ledger = new LedgerService(() => new Date());
    support = new SupportService({ ledger, plans: {} as PlanService, programmeNow: () => new Date() });
  }, 90_000);

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
    await c?.close();
  });

  it('isAvailable (officer token): open inside the mentor\'s office hours, closed for a mentor without availability', async () => {
    const day = candidateSlotDays(new Date(Date.now() + 2 * DAY), { days: 1 })[0]!;
    const s = day[0]!.getTime() / 1000;
    expect(await c.mentoring.isAvailable(officer, mentorId, s, s + 3600)).toBe(true);
    expect(await c.mentoring.isAvailable(officer, wasteId, s, s + 3600)).toBe(false);
  });

  it('shortlist: the {hand hygiene, Hindi} mentor ranks first with an open slot probed from ELEVATE', async () => {
    const officerActor: SupportActor = { userId: officerId, role: 'IPC_OFFICER', assignments: [] };
    const ward = await WardModel.findOne({ wardCode: /HA-W4$/ }).lean();
    const scope = new ScopeService(ledger);
    const eff = await scope.effective(officerId);
    const actor = { ...officerActor, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })) };
    const created = await support.create({ wardId: String(ward!._id), problem: 'Hand hygiene compliance stuck at 40%', skill: 'hand_hygiene', language: 'hi' }, actor);
    requestId = created.id;
    // The Edge's probe, done here with the same ELEVATE call: first open slot per mentor.
    const plan = await support.probePlan();
    const facts = await Promise.all(plan.mentorIds.map(async (id) => {
      for (const day of plan.slotDays) {
        const hits = await Promise.all(day.map((s) => c.mentoring.isAvailable(officer, id, Date.parse(s) / 1000, Date.parse(s) / 1000 + 3600)));
        const i = hits.indexOf(true);
        if (i >= 0) return { mentorId: id, nextOpenSlotAt: day[i]! };
      }
      return { mentorId: id, nextOpenSlotAt: null };
    }));
    const s = await support.shortlist(requestId, actor, facts);
    expect(s.items[0]).toMatchObject({ mentorId, rank: 1, skillMatch: true, languageMatch: true, available: true });
    expect(s.items.find((x) => x.mentorId === wasteId)).toMatchObject({ skillMatch: false, available: false });
  }, 90_000);

  it('requestSessions: create (officer token) → list (officer, mentor) → accept (mentor) → list ACCEPTED', async () => {
    let created: { id: string } | undefined;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const start = randomSlot();
      try {
        const r = await c.mentoring.createSessionRequest(officer, { requesteeId: mentorId, title: elevateTitle('IPC support: hand hygiene (Ward 4)'), agenda: 'Hand hygiene compliance stuck at 40%', startDate: start, endDate: start + 3600 });
        await c.mentoring.acceptSessionRequest(mentor, r.id);
        created = r;
      } catch (e) {
        console.warn("session attempt failed", e instanceof ElevateError ? `${e.status} ${JSON.stringify((e as { body?: unknown }).body ?? e.message).slice(0, 300)}` : e);
        if (!(e instanceof ElevateError) || e.status >= 500) throw e; // a clash with an earlier run's slot: try another
      }
    }
    expect(created).toBeDefined();
    const asOfficer = await c.mentoring.listSessionRequests(officer, ALL);
    const mine = asOfficer.data.find((r) => r.id === created!.id);
    expect(mine).toMatchObject({ requestor_id: officerId, requestee_id: mentorId, status: 'ACCEPTED' });
    const asMentor = await c.mentoring.listSessionRequests(mentor, ALL);
    expect(asMentor.data.some((r) => r.id === created!.id)).toBe(true);

    // Workflow: record the reference (as the Edge does after create), then the ELEVATE fact → accepted.
    await SupportRequestModel.updateOne({ _id: requestId }, { $set: { status: 'requested', chosenMentorId: mentorId, elevateRequestSessionId: created!.id }, $inc: { v: 1 } });
    const scope = new ScopeService(ledger);
    expect((await scope.effective(mentorId)).mentorFacilityIds ?? []).toEqual([]);
    const changed = await support.sync({ userId: mentorId, role: 'MENTOR', assignments: [] }, asMentor.data.map((r) => ({ id: r.id, status: r.status })));
    expect(changed).toEqual([requestId]);
    const doc = await SupportRequestModel.findById(requestId).lean();
    expect(doc?.status).toBe('accepted');
    expect(await LedgerRecordModel.exists({ action: 'support_request.accepted', 'subject.id': requestId })).toBeTruthy();
    // US6 AS3: the mentor now sees exactly the facility of the accepted request.
    expect((await scope.effective(mentorId)).mentorFacilityIds).toEqual([String(doc!.facilityId)]);
    // a second sync is a no-op (idempotent)
    expect(await support.sync({ userId: mentorId, role: 'MENTOR', assignments: [] }, [{ id: created!.id, status: 'ACCEPTED' }])).toEqual([]);
  }, 90_000);
});
