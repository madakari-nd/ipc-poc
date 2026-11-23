/**
 * Shared plumbing for `scripts/seed.ts` and `scripts/reset.ts`: CLI args, the profile env file
 * (read, and write-back of generated values BEFORE they are used), secret redaction and the seed
 * state file `infra/compose/.seed-state.<profile>.json` that keeps the ELEVATE ids so re-runs reuse
 * them. Nothing here prints a secret.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '@ipc/elevate-client';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PROFILES = ['dev', 'test', 'uat', 'prod'] as const;
export type Profile = (typeof PROFILES)[number];

export interface SeedArgs { profile: Profile; mongoUrl?: string; yesReally: boolean }

export function parseArgs(argv = process.argv.slice(2)): SeedArgs {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i > -1) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    return eq?.slice(flag.length + 1);
  };
  const profile = (val('--profile') ?? process.env.IPC_PROFILE ?? 'test') as Profile;
  if (!PROFILES.includes(profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
  const mongoUrl = val('--mongo-url');
  return { profile, ...(mongoUrl ? { mongoUrl } : {}), yesReally: argv.includes('--yes-really') };
}

export const envPath = (p: Profile) => join(ROOT, 'infra/compose', `.env.${p}`);

/** The profile env file, with secret redaction and a safe write-back. */
export class ProfileEnv {
  values: Record<string, string>;

  constructor(readonly profile: Profile) {
    const path = envPath(profile);
    if (!existsSync(path)) throw new Error(`${path} not found (copy infra/compose/.env.example)`);
    this.values = readEnvFile(path);
  }

  get(key: string): string { return this.values[key] ?? ''; }

  require(key: string): string {
    const v = this.get(key);
    if (!v) throw new Error(`${key} is empty in .env.${this.profile}`);
    return v;
  }

  /**
   * Sets KEY=value in the env file (replacing an existing line, else appending) and fsyncs it by
   * rename. Called BEFORE the API call that uses a generated value, so it cannot be lost.
   */
  set(key: string, value: string): void {
    if (this.values[key] === value) return;
    const path = envPath(this.profile);
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const i = lines.findIndex((l) => re.test(l));
    const line = `${key}=${value}`;
    if (i > -1) lines[i] = line;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(line, '');
    }
    writeFileSync(`${path}.tmp`, lines.join('\n'), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.values[key] = value;
  }

  /** Redacts every secret-looking env value and any JWT. */
  redact(s: string): string {
    const secrets = Object.entries(this.values)
      .filter(([k, v]) => /TOKEN|PASSWORD|SECRET|KEY/.test(k) && v.length >= 4)
      .map(([, v]) => v)
      .sort((a, b) => b.length - a.length);
    return secrets.reduce((acc, v) => acc.split(v).join('[redacted]'), s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]');
  }
}

/** A password that meets ELEVATE's default policy (upper, lower, digit, special, ≥ 8). */
export function generatePassword(): string {
  return `Ipc#${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}7a`;
}

// ---------------------------------------------------------------------------------------------
// Seed state (ELEVATE ids). Gitignored; holds ids only, never credentials.
// ---------------------------------------------------------------------------------------------

export interface FormQuestion {
  externalId: string; text: string; responseType: string; evidence: string; section: string; options: string[];
}

export interface SeedState {
  /** Bumped by reset: ELEVATE codes and logins of generation n > 1 carry `G<n>-`, because ELEVATE
   * cannot delete users or entities, and externalIds / emails must stay unique. */
  generation: number;
  users: Record<string, { id: number; email: string }>;
  roleAssigned: Record<string, boolean>;
  mentorRequests: Record<string, number>;
  mentorExtensions: Record<string, boolean>;
  entityTypes: Record<string, string>;
  entities: Record<string, string>;
  mapped: Record<string, boolean>;
  checklist?: { _id: string; externalId: string };
  formQuestions?: FormQuestion[];
  planTemplate?: { templateId: string; externalId: string; taskIds: Record<string, string> };
  planProgram?: { _id: string; externalId: string };
  cycles: Record<string, {
    observationSolutionId?: string; observationSolutionExternalId?: string; observationSolutionTyped?: boolean;
    planSolutionId?: string; planTemplateCopyId?: string;
  }>;
  observations: Record<string, string>;
  submissions: Record<string, string>;
  completed: Record<string, { at: string; answers: Record<string, boolean> }>;
  schedulerJobId?: string;
}

export const statePath = (p: Profile) => join(ROOT, 'infra/compose', `.seed-state.${p}.json`);

export function emptyState(generation = 1): SeedState {
  return {
    generation, users: {}, roleAssigned: {}, mentorRequests: {}, mentorExtensions: {}, entityTypes: {}, entities: {}, mapped: {},
    cycles: {}, observations: {}, submissions: {}, completed: {},
  };
}

export function loadState(p: Profile): SeedState {
  const path = statePath(p);
  if (!existsSync(path)) return emptyState();
  return { ...emptyState(), ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<SeedState>) } as SeedState;
}

export function saveState(p: Profile, s: SeedState): void {
  const path = statePath(p);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** ELEVATE code prefix for the generation: `TEST-` then `TEST-G2-`, `TEST-G3-` … */
export function codePrefix(base: string, generation: number): string {
  return generation > 1 ? `${base}G${generation}-` : base;
}

/** Mongo URL for the programme stores: --mongo-url, else MONGO_URL. */
export function programmeMongoUrl(args: SeedArgs, env: ProfileEnv): string {
  const url = args.mongoUrl ?? env.get('MONGO_URL');
  if (!url) throw new Error('no programme Mongo: pass --mongo-url or set MONGO_URL');
  return url;
}
