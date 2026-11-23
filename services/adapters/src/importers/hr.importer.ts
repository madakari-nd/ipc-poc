import type { Model } from 'mongoose';
import { z } from 'zod';
import { ElevateError } from '@ipc/elevate-client';
import { CsvError, parseCsv, splitList, type CsvRow } from './csv.js';
import { ImportReport, type HrStaffDoc } from './job.js';
import { RegisterRowError, isUserExists, type ElevateImportPort, type RegisterPort } from './ports.js';

/**
 * Staff (HR) import (T070, FR-002/FR-003, research E2/E3). Columns (case/space-insensitive):
 *   staff_id, name, email, role, status, district_code, facility_code, ward_codes, about
 * - `role` is a programme role; `facility_code` may list several (`;`) for EXTERNAL_AUDITOR;
 *   `ward_codes` is a `;` list. `status` is `active` (default) or `left`.
 * - Users are created ONE AT A TIME (account/create; bulk create needs cloud storage, E2) and get
 *   the ELEVATE `user` role with assignRole (admin token). Mentors instead go through mentoring's
 *   role request → org-admin approval (E3: assignRole does not tell mentoring).
 * - Leavers are deactivated in ELEVATE (org admin), their programme scope ends and their open tasks
 *   appear in the supervisor's "needs reassignment" list (workflow `/internal/register/staff`).
 * - The staff map (staff id → ELEVATE user id) makes a re-run an upsert by staff code.
 */
export const HR_COLUMNS = ['staff_id', 'name', 'role'] as const;
export const PER_RECORD_SUBSTITUTION = 'Users created one at a time with account/create + assignRole (bulk user upload needs cloud storage, E2)';
export const MENTOR_SUBSTITUTION = 'Mentors onboarded through the mentoring role request and org-admin approval (E3)';

const ROLES = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR'] as const;

const rowSchema = z.object({
  staff_id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'letters, digits, . _ - only'),
  name: z.string().min(1).max(200),
  email: z.string().email().max(254).optional(),
  role: z.string().transform((s) => s.trim().toUpperCase().replace(/[\s-]+/g, '_')).pipe(z.enum(ROLES)),
  status: z.string().default('active').transform((s) => s.trim().toLowerCase()).pipe(z.enum(['active', 'left'])),
  district_code: z.string().max(32).optional(),
  facility_code: z.string().max(400).optional(),
  ward_codes: z.string().max(2000).optional(),
  about: z.string().max(300).optional(),
});
type Row = z.infer<typeof rowSchema>;

/** ELEVATE names accept letters and spaces only (observed: "This field can only contain alphabets"). */
export function elevateName(name: string): string {
  return name.normalize('NFKD').replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Programme scope by role, named by codes (workflow resolves codes to ids and checks the role rule). */
export function scopeFor(r: Row): { level: string; districtCode?: string; facilityCode?: string; facilityCodes?: string[]; wardCodes?: string[] } | string {
  const facilities = splitList(r.facility_code);
  const wards = splitList(r.ward_codes);
  switch (r.role) {
    case 'STATE_ADMIN': return { level: 'state' };
    case 'DISTRICT_QM': return r.district_code ? { level: 'district', districtCode: r.district_code } : 'district_code is required for DISTRICT_QM';
    case 'IPC_OFFICER': return facilities.length === 1 ? { level: 'facility', facilityCode: facilities[0] } : 'exactly one facility_code is required for IPC_OFFICER';
    case 'EXTERNAL_AUDITOR': return facilities.length ? { level: 'facility', facilityCodes: facilities } : 'facility_code is required for EXTERNAL_AUDITOR';
    case 'WARD_SUPERVISOR':
      return facilities.length === 1 && wards.length ? { level: 'wards', facilityCode: facilities[0], wardCodes: wards } : 'one facility_code and ward_codes are required for WARD_SUPERVISOR';
    case 'FRONTLINE':
      if (facilities.length === 1 && wards.length) return { level: 'wards', facilityCode: facilities[0], wardCodes: wards };
      return facilities.length === 1 ? { level: 'own_tasks', facilityCode: facilities[0] } : { level: 'own_tasks' };
    case 'MENTOR': return { level: 'own_tasks' };
  }
}

export interface HrImportDeps {
  elevate: ElevateImportPort;
  register: RegisterPort;
  staff: Model<HrStaffDoc>;
  /** First password of new accounts (users change it on first sign-in; never logged). */
  initialPassword: string;
  dryRun: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function userIdFor(r: Row & { email: string }, d: HrImportDeps): Promise<{ id: number; token: string; created: boolean }> {
  try {
    const c = await d.elevate.createAccount({ name: elevateName(r.name), email: r.email, password: d.initialPassword });
    return { id: c.user.id, token: c.access_token, created: true };
  } catch (e) {
    if (!isUserExists(e)) throw e;
    // Already in ELEVATE (earlier import or created elsewhere): adopt it when the first password still works.
    const l = await d.elevate.login(r.email, d.initialPassword).catch(() => {
      throw new RowFailure('USER_EXISTS', `${r.email} already exists in ELEVATE and could not be matched; add it to the staff map manually`);
    });
    return { id: l.user.id, token: l.access_token, created: false };
  }
}

class RowFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

async function activeRow(r: Row, row: number, d: HrImportDeps, report: ImportReport) {
  const scope = scopeFor(r);
  if (typeof scope === 'string') throw new RowFailure('VALIDATION_FAILED', scope);
  const existing = await d.staff.findOne({ staffId: r.staff_id }).lean<HrStaffDoc>();
  const email = r.email ?? existing?.email;
  if (!email) throw new RowFailure('VALIDATION_FAILED', 'email is required for a new staff member');
  if (d.dryRun) return;

  let userId = existing?.elevateUserId;
  let token: string | undefined;
  let createdUser = false;
  if (!userId) {
    const u = await userIdFor({ ...r, email }, d);
    userId = String(u.id);
    token = u.token;
    createdUser = u.created;
  }
  await d.staff.updateOne(
    { staffId: r.staff_id },
    { $set: { elevateUserId: userId, email, name: r.name, role: r.role, status: 'active' } },
    { upsert: true },
  );

  // ELEVATE role (once per staff member): mentors via request + approve, everyone else `user`.
  const wantedRole = r.role === 'MENTOR' ? 'mentor' : 'user';
  if (existing?.elevateRole !== wantedRole) {
    if (wantedRole === 'mentor') {
      report.substitutions.add(MENTOR_SUBSTITUTION);
      token ??= (await d.elevate.login(email, d.initialPassword).catch(() => {
        throw new RowFailure('MENTOR_REQUEST_FAILED', 'Cannot sign in as the mentor to request the mentor role (password changed?)');
      })).access_token;
      const req = await d.elevate.requestRole(token, 'mentor', r.about ?? 'IPC programme expert mentor');
      if (req.status === 'REQUESTED') await d.elevate.approveRoleRequest(req.id);
      await d.staff.updateOne({ staffId: r.staff_id }, { $set: { elevateRole: 'mentor', mentorRequestId: req.id } });
    } else {
      // assignRole ends the user's ELEVATE sessions; the importer never needs them afterwards.
      await d.elevate.assignRole(Number(userId), 'user');
      await d.staff.updateOne({ staffId: r.staff_id }, { $set: { elevateRole: 'user' } });
    }
  }

  const res = await d.register.applyStaff({ userId, name: r.name, role: r.role, status: 'active', scope, reason: `HR import row ${row}` });
  if (createdUser || res.outcome === 'created') report.counts.created += 1;
  else if (res.outcome === 'updated' || (existing && existing.name !== r.name)) report.counts.updated += 1;
}

async function leaverRow(r: Row, row: number, d: HrImportDeps, report: ImportReport) {
  const existing = await d.staff.findOne({ staffId: r.staff_id }).lean<HrStaffDoc>();
  let userId = existing?.elevateUserId;
  if (!userId && r.email) userId = String((await d.elevate.login(r.email, d.initialPassword).catch(() => null))?.user.id ?? '') || undefined;
  if (!userId) throw new RowFailure('UNKNOWN_STAFF', `Staff ${r.staff_id} was never imported, so there is nobody to deactivate`);
  if (d.dryRun) return;
  if (existing?.status !== 'left') {
    await d.elevate.deactivate(Number(userId));
    await d.staff.updateOne(
      { staffId: r.staff_id },
      { $set: { elevateUserId: userId, email: r.email ?? existing?.email ?? `${r.staff_id}@unknown.invalid`, name: r.name, role: r.role, status: 'left' } },
      { upsert: true },
    );
  }
  const scope = scopeFor(r);
  const res = await d.register.applyStaff({
    userId, name: r.name, role: r.role, status: 'left', scope: typeof scope === 'string' ? { level: 'own_tasks' } : scope, reason: `HR import row ${row}`,
  });
  if (existing?.status !== 'left' || res.outcome === 'deactivated') report.counts.deactivated += 1;
  report.counts.tasksNeedingReassignment += res.tasksNeedingReassignment;
}

export async function runHrImport(csv: string, d: HrImportDeps): Promise<ImportReport> {
  const report = new ImportReport();
  let rows: CsvRow[];
  try {
    rows = parseCsv(csv, HR_COLUMNS);
  } catch (e) {
    if (e instanceof CsvError) {
      report.counts.rows = 1;
      report.fail(1, 'INVALID_FILE', e.message);
      return report;
    }
    throw e;
  }
  report.counts.rows = rows.length;
  if (!d.dryRun) report.substitutions.add(PER_RECORD_SUBSTITUTION);
  const seen = new Set<string>();
  for (const { row, cells } of rows) {
    const p = rowSchema.safeParse(Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== '')));
    if (!p.success) {
      const i = p.error.issues[0]!;
      report.fail(row, 'VALIDATION_FAILED', `${i.path.join('.') || 'row'}: ${i.message}`);
      continue;
    }
    if (seen.has(p.data.staff_id)) {
      report.fail(row, 'DUPLICATE_STAFF', `staff_id ${p.data.staff_id} appears twice`);
      continue;
    }
    seen.add(p.data.staff_id);
    try {
      if (p.data.status === 'left') await leaverRow(p.data, row, d, report);
      else await activeRow(p.data, row, d, report);
    } catch (e) {
      if (e instanceof RowFailure) report.fail(row, e.code, e.message);
      else if (e instanceof RegisterRowError) report.fail(row, e.code, e.message);
      else if (e instanceof ElevateError) report.fail(row, e.isServerError ? 'ELEVATE_UNAVAILABLE' : 'ELEVATE_REFUSED', message(e));
      else report.fail(row, 'ELEVATE_UNAVAILABLE', message(e));
    }
  }
  return report;
}
