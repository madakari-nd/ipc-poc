/**
 * SC-004 / US3 AS1 against the REAL local ELEVATE (Constitution I): officer-a completes a Ward 4
 * submission of the active cycle in samiksha; the workflow observation consumer (in process, own
 * consumer group, the seeded programme Mongo of the test profile) must turn ELEVATE's completion
 * event into a DraftPlan in under 60 s. Ward 4 C1 programme records (plans, tasks, revisions,
 * assessment contexts) are reset first so the completion is the first of the cycle; ELEVATE keeps
 * every submission (a new submission number per run).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Kafka, logLevel } from 'kafkajs';
import { createLogger } from '@ipc/platform';
import {
  ElevateError, buildAnswer, createElevateClients, ElevateConfigSchema, flattenQuestions, readEnvFile, type Answer, type ElevateClients,
} from '@ipc/elevate-client';
import { createConsumers } from '../../services/workflow/src/consumers/registry.js';
import { startConsumers, type RunningConsumers } from '../../services/workflow/src/consumers/runner.js';
import { rootExternalId } from '../../services/workflow/src/domain/catalogue.js';
import {
  AssessmentContextModel, ChecklistVersionModel, CycleModel, PlanModel, PlanRevisionModel, TaskModel, WardModel,
} from '../../services/workflow/src/domain/models/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const ready = existsSync(envPath) && existsSync(statePath);
const env = ready ? readEnvFile(envPath) : {};
const state = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as {
  users: Record<string, { email: string }>; entities: Record<string, string>; observations: Record<string, string>;
  formQuestions: { externalId: string }[];
}) : undefined;

const logger = createLogger('plan-timing', 'silent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ward 4 C1 back to "no assessment completed yet" in the programme (ELEVATE is untouched). */
export async function resetWard4Cycle(wardId: unknown, cycleId: unknown) {
  const plans = await PlanModel.find({ wardId, cycleId }, { _id: 1 }).lean();
  const ids = plans.map((p) => p._id);
  await TaskModel.collection.deleteMany({ planId: { $in: ids } });
  await PlanRevisionModel.collection.deleteMany({ planId: { $in: ids } });
  await PlanModel.collection.deleteMany({ _id: { $in: ids } });
  await AssessmentContextModel.collection.deleteMany({ wardId, cycleId });
}

/**
 * Completes one Ward 4 submission as officer-a: the first catalogue question (critical,
 * hand_rub_at_bed) fails, the second passes. Returns the submission id.
 */
export const ward4Entity = (s: { entities: Record<string, string> }) => Object.entries(s.entities).find(([k]) => k.endsWith('-HA-W4'))![1];

export async function completeWard4(c: ElevateClients, s: NonNullable<typeof state>, password: string): Promise<string> {
  const token = (await c.user.login(s.users['officer-a']!.email, password)).access_token;
  const obs = s.observations['2026-C1:officer-a']!;
  const entity = ward4Entity(s);
  let subs = await c.samiksha.listSubmissions(token, obs, entity);
  let open = subs.find((x) => x.status !== 'completed');
  if (!open) {
    await c.samiksha.createSubmission(token, obs, entity);
    subs = await c.samiksha.listSubmissions(token, obs, entity);
    open = subs.find((x) => x.status !== 'completed');
  }
  if (!open) throw new Error('no open Ward 4 submission');
  const form = await c.samiksha.assessmentForm(token, obs, entity, open.submissionNumber ?? subs.length);
  const [failRoot, passRoot] = s.formQuestions.map((q) => rootExternalId(q.externalId));
  for (const ev of form.assessment.evidences) {
    const answers: Record<string, Answer> = {};
    for (const q of flattenQuestions(ev)) {
      const opts = (q.options ?? []).map((o) => o.value);
      const root = q.externalId ? rootExternalId(q.externalId) : '';
      const value = root === passRoot ? (q.responseType === 'multiselect' ? opts : opts.at(-1))
        : q.responseType === 'multiselect' ? opts.slice(0, 1) : root === failRoot ? opts[0] : opts.at(-1) ?? 'IPC test';
      answers[q._id] = buildAnswer(q, value ?? '');
    }
    try {
      await c.samiksha.submitEvidence(token, form.assessment.submissionId, { externalId: ev.externalId, answers }, '0,0');
    } catch (e) {
      // The call completing the last evidence can answer 500 while completing (preflight check 6).
      if (!(e instanceof ElevateError && e.isServerError)) throw e;
    }
  }
  return form.assessment.submissionId;
}

describe.skipIf(!ready || !env.DEMO_USER_PASSWORD)('SC-004: ELEVATE completion → draft plan (real ELEVATE)', () => {
  let clients: ElevateClients;
  let running: RunningConsumers;
  let ward: { _id: unknown };
  let cycle: { _id: unknown };

  beforeAll(async () => {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });
    clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-plan-timing-test' });
    ward = (await WardModel.findOne({ elevateEntityId: ward4Entity(state!) }).lean())!;
    cycle = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
    expect(ward && cycle && (await ChecklistVersionModel.exists({ status: 'published' }))).toBeTruthy();
    const kafka = new Kafka({ clientId: 'ipc-plan-timing-test', brokers: env.ELEVATE_KAFKA_BROKERS!.split(','), logLevel: logLevel.NOTHING });
    running = await startConsumers(kafka, createConsumers({ logger, orgId: env.ELEVATE_ORG_ID ?? env.ELEVATE_ORG_CODE ?? 'default_code' }), {
      groupId: `ipc-plan-timing-${Date.now()}`, logger,
    });
    await sleep(6000); // let the group join before ELEVATE publishes
  }, 120_000);

  afterAll(async () => {
    await running?.stop();
    await clients?.close();
    await mongoose.disconnect();
  });

  it('a completed Ward 4 assessment with a critical finding is a draft plan within 60 s', async () => {
    await resetWard4Cycle(ward._id, cycle._id);
    const submittedAt = Date.now();
    const submissionId = await completeWard4(clients, state!, env.DEMO_USER_PASSWORD!);
    let plan = null;
    while (!plan && Date.now() - submittedAt < 75_000) {
      plan = await PlanModel.findOne({ wardId: ward._id, cycleId: cycle._id }).lean();
      if (!plan) await sleep(250);
    }
    expect(plan, 'no draft plan within 75 s').toBeTruthy();
    const ctx = await AssessmentContextModel.findOne({ elevateSubmissionId: submissionId }).lean();
    expect(ctx).toMatchObject({ status: 'completed', failedQuestionKeys: expect.arrayContaining(['hand_rub_at_bed']) });
    const eventToDraftMs = plan!.createdAt.getTime() - ctx!.completedAt!.getTime();
    const submitToDraftMs = plan!.createdAt.getTime() - submittedAt;
    console.log(`SC-004 event → DraftPlan ${eventToDraftMs} ms (submit → draft ${submitToDraftMs} ms)`);
    expect(eventToDraftMs).toBeLessThan(60_000);
    expect(plan!.draftTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKey: 'fit-hand-rub-dispensers', riskLevel: 'critical', secondValidation: true, evidenceRule: { photoRequired: true, minPhotos: 1 } }),
    ]));
    const due = plan!.draftTasks!.find((t) => t.taskKey === 'fit-hand-rub-dispensers')!.dueAt.getTime() - plan!.createdAt.getTime();
    expect(Math.round(due / 86_400_000)).toBe(7);
  }, 120_000);
});
