/**
 * Direct-ELEVATE side of the security suite (research §4): the same attack is sent straight to the
 * REAL local ELEVATE (Constitution I, no mocks) and the actual answer is recorded, so the report
 * can show what the Edge prevents. Uses the lab users from the 2026-10-23 validation
 * (`ipc.hospa@example.org` = org default_code, `ipc.hospb@example.org` = org hosp_b).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
export const env: Record<string, string> = existsSync(envPath) ? readEnvFile(envPath) : {};

/** Validation logs of 2026-10-23 (research-elevate.md `VAL/`). */
export const VALIDATION_DIR = process.env.SEC_VALIDATION_DIR ?? '/home/hp/elevate-lab/submission/validation';

/**
 * Lab fixtures created during the 2026-10-23 validation and still present on the local stack
 * (overridable per environment).
 */
export const LAB = {
  hospA: process.env.SEC_HOSPA_EMAIL ?? 'ipc.hospa@example.org',
  hospB: process.env.SEC_HOSPB_EMAIL ?? 'ipc.hospb@example.org',
  password: process.env.SEC_LAB_PASSWORD ?? env.ELEVATE_TEST_USER_PASSWORD ?? '',
  /** V3 targeting body (validation v3_targeting_scope.sh): profile ids of the sample state/district/role. */
  targeting: {
    state: '6852c86c7248c20014b38a4d',
    district: '6852c8ae7248c20014b38a57',
    professional_role: '68876746b19aea00144c2af9',
    professional_subroles: '688767deb19aea00144c2b08',
  },
  /** V4: Hospital A's improvement project (imported in V4) and its 'simple' task. */
  projectA: process.env.SEC_V4_PROJECT_ID ?? '6adae0e2751fed469e6be241',
  projectTaskA: process.env.SEC_V4_TASK_ID ?? '879faa7a-8d25-4695-a6c2-906b8cd90092',
  /** V5b: Hospital A's draft observation submission (created in V5b) and one radio question. */
  submissionA: process.env.SEC_V5B_SUBMISSION_ID ?? '6adaebede58ea8cc892128f1',
  questionA: process.env.SEC_V5B_QUESTION_ID ?? '691b17ae1ce3f5956e9f3185',
};

export const url = (key: string, fallback: string) => (env[key] || fallback).replace(/\/+$/, '');

/** Undefined when the direct side can run; otherwise why not (recorded in the report). */
export async function directSkipReason(): Promise<string | undefined> {
  if (!existsSync(envPath)) return `${envPath} not found`;
  if (!LAB.password) return 'lab user password not configured (SEC_LAB_PASSWORD / ELEVATE_TEST_USER_PASSWORD)';
  // The user service can be slow under a parallel suite: two attempts, 15 s each.
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${url('ELEVATE_USER_URL', 'http://localhost:3001')}/user/v1/account/login`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (r.status > 0) return undefined;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  return `ELEVATE unreachable: ${last}`;
}

let clients: ElevateClients | undefined;
export function elevate(): ElevateClients {
  clients ??= createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-security-test' });
  return clients;
}

const tokens = new Map<string, string>();
/** ELEVATE access token for a lab user (cached for the run; tokens live 30 minutes). */
export async function token(who: 'hospA' | 'hospB'): Promise<string> {
  const cached = tokens.get(who);
  if (cached) return cached;
  const t = (await elevate().user.login(LAB[who], LAB.password)).access_token;
  tokens.set(who, t);
  return t;
}

export interface DirectAnswer {
  status: number;
  body: Record<string, unknown> | undefined;
}

/**
 * Raw call that keeps the real HTTP status (the typed client throws on 4xx, which would hide
 * exactly what the report must show). `token` null = no credentials at all.
 */
export async function call(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  o: { token?: string | null; body?: unknown } = {},
): Promise<DirectAnswer> {
  const headers: Record<string, string> = {};
  if (o.token) headers['x-auth-token'] = o.token;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body };
}
