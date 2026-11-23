import { z } from 'zod';
import { CsvError, parseCsv, type CsvRow } from './csv.js';
import { ImportReport } from './job.js';
import { RegisterRowError, type ElevateImportPort, type RegisterPort } from './ports.js';

/**
 * Facility-master import (T069, FR-001/FR-002, research E4). One CSV row per ward; a hospital row
 * without a ward code is allowed. Columns (header names are case/space-insensitive):
 *   facility_code, facility_name, district_code, level, lat, lng, status, ward_code, ward_name, ward_type, ward_active
 * The facility code is the ELEVATE externalId. Hospitals and wards missing in ELEVATE are created
 * with entities/bulkCreate (one call per type), wards are linked with mappingUpload, then the
 * programme register is upserted in workflow (the single writer of facilities and wards).
 */
export const FACILITY_COLUMNS = ['facility_code', 'facility_name', 'district_code', 'level', 'lat', 'lng'] as const;

/** Observed 2026-11-23 on entity-management 3.4: metaInformation keeps only externalId and name. */
export const LOCATION_SUBSTITUTION =
  'Location kept in the programme register: ELEVATE entity metaInformation stores only externalId and name on this image (E4)';
export const BULK_SUBSTITUTION = 'Entities created with entities/bulkCreate; existing entities looked up first (a duplicate fails the whole batch)';

const code = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'letters, digits, . _ - only');
const rowSchema = z.object({
  facility_code: code,
  facility_name: z.string().min(1).max(200),
  district_code: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/, 'letters, digits, . _ - only (max 32)'),
  level: z.enum(['district', 'sub-district', 'community']),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  status: z.enum(['active', 'inactive']).default('active'),
  ward_code: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/, 'letters, digits, . _ - only (max 32)')]).default(''),
  ward_name: z.string().max(200).default(''),
  ward_type: z.string().max(32).default(''),
  ward_active: z.enum(['', 'true', 'false', 'yes', 'no', '1', '0']).default('').transform((v) => !['false', 'no', '0'].includes(v)),
});
type Row = z.infer<typeof rowSchema>;

interface FacilityPlan {
  rows: number[];
  facility: { code: string; name: string; districtCode: string; level: Row['level']; location: { lat: number; lng: number }; status: Row['status'] };
  wards: Map<string, { code: string; name: string; type: string; active: boolean; row: number }>;
}

function blank(v: string | undefined) {
  return v === undefined || v === '';
}

/** Groups valid rows by facility; invalid rows are reported and skipped. */
export function planFacilities(rows: CsvRow[], report: ImportReport): Map<string, FacilityPlan> {
  const out = new Map<string, FacilityPlan>();
  for (const r of rows) {
    const cells = Object.fromEntries(Object.entries(r.cells).filter(([, v]) => !blank(v)));
    const p = rowSchema.safeParse(cells);
    if (!p.success) {
      const i = p.error.issues[0]!;
      report.fail(r.row, 'VALIDATION_FAILED', `${i.path.join('.') || 'row'}: ${i.message}`);
      continue;
    }
    const v = p.data;
    if (v.ward_code && (!v.ward_name || !v.ward_type)) {
      report.fail(r.row, 'VALIDATION_FAILED', 'ward_name and ward_type are required with ward_code');
      continue;
    }
    let plan = out.get(v.facility_code);
    const facility = { code: v.facility_code, name: v.facility_name, districtCode: v.district_code, level: v.level, location: { lat: v.lat, lng: v.lng }, status: v.status };
    if (!plan) {
      plan = { rows: [], facility, wards: new Map() };
      out.set(v.facility_code, plan);
    } else if (JSON.stringify(plan.facility) !== JSON.stringify(facility)) {
      report.fail(r.row, 'INCONSISTENT_FACILITY', `Facility ${v.facility_code} has different details on another row`);
      continue;
    }
    plan.rows.push(r.row);
    if (v.ward_code) {
      if (plan.wards.has(v.ward_code)) {
        report.fail(r.row, 'DUPLICATE_WARD', `Ward ${v.ward_code} appears twice for ${v.facility_code}`);
        continue;
      }
      plan.wards.set(v.ward_code, { code: v.ward_code, name: v.ward_name, type: v.ward_type, active: v.ward_active, row: r.row });
    }
  }
  return out;
}

/** Ensures entities exist in ELEVATE; returns externalId → entity _id. */
async function ensureEntities(
  elevate: ElevateImportPort,
  type: 'hospital' | 'ward',
  wanted: { externalId: string; name: string }[],
): Promise<{ ids: Map<string, string>; created: Set<string>; existing: Map<string, { id: string; name?: string; childIds: string[] }> }> {
  const ids = new Map<string, string>();
  const existing = new Map<string, { id: string; name?: string; childIds: string[] }>();
  const missing: { externalId: string; name: string }[] = [];
  for (const w of wanted) {
    const e = await elevate.findEntity(w.externalId);
    if (e) {
      ids.set(w.externalId, e._id);
      const groups = (e as { groups?: Record<string, string[]> }).groups ?? {};
      existing.set(w.externalId, { id: e._id, name: e.metaInformation?.name, childIds: groups.ward ?? [] });
    } else missing.push(w);
  }
  const created = new Set<string>();
  if (missing.length) {
    const echo = await elevate.bulkCreateEntities(type, missing);
    for (const m of missing) {
      const row = echo.find((x) => x.externalId === m.externalId);
      let id = row?._SYSTEM_ID && /^[a-f0-9]{24}$/.test(row._SYSTEM_ID) ? row._SYSTEM_ID : undefined;
      id ??= (await elevate.findEntity(m.externalId))?._id;
      if (id) {
        ids.set(m.externalId, id);
        created.add(m.externalId);
      }
    }
  }
  return { ids, created, existing };
}

export async function runFacilityImport(
  csv: string,
  d: { elevate: ElevateImportPort; register: RegisterPort; dryRun: boolean },
): Promise<ImportReport> {
  const report = new ImportReport();
  let rows: CsvRow[];
  try {
    rows = parseCsv(csv, FACILITY_COLUMNS);
  } catch (e) {
    if (e instanceof CsvError) {
      report.counts.rows = 1;
      report.fail(1, 'INVALID_FILE', e.message);
      return report;
    }
    throw e;
  }
  report.counts.rows = rows.length;
  const plans = planFacilities(rows, report);
  if (d.dryRun) return report;
  report.substitutions.add(LOCATION_SUBSTITUTION);
  report.substitutions.add(BULK_SUBSTITUTION);

  const facilities = [...plans.values()];
  let hospitals: Awaited<ReturnType<typeof ensureEntities>>;
  let wards: Awaited<ReturnType<typeof ensureEntities>>;
  try {
    hospitals = await ensureEntities(d.elevate, 'hospital', facilities.map((p) => ({ externalId: p.facility.code, name: p.facility.name })));
    wards = await ensureEntities(d.elevate, 'ward', facilities.flatMap((p) => [...p.wards.values()].map((w) => ({ externalId: w.code, name: w.name }))));
  } catch (e) {
    for (const p of facilities) for (const r of p.rows) report.fail(r, 'ELEVATE_UNAVAILABLE', `ELEVATE entity write failed: ${(e as Error).message}`);
    return report;
  }

  // Link wards to their hospital (skipped when ELEVATE already lists the ward under it).
  const pairs: { parentId: string; childId: string }[] = [];
  for (const p of facilities) {
    const parent = hospitals.ids.get(p.facility.code);
    const known = new Set(hospitals.existing.get(p.facility.code)?.childIds ?? []);
    for (const w of p.wards.values()) {
      const child = wards.ids.get(w.code);
      if (parent && child && !known.has(child)) pairs.push({ parentId: parent, childId: child });
    }
  }
  try {
    await d.elevate.mapChildren(pairs);
  } catch (e) {
    for (const p of facilities) for (const r of p.rows) report.fail(r, 'ELEVATE_UNAVAILABLE', `ELEVATE mapping failed: ${(e as Error).message}`);
    return report;
  }
  // Renamed in the file → renamed in ELEVATE.
  for (const p of facilities) {
    const ex = hospitals.existing.get(p.facility.code);
    if (ex && ex.name !== undefined && ex.name !== p.facility.name) await d.elevate.renameEntity(ex.id, p.facility.code, p.facility.name).catch(() => undefined);
  }

  for (const p of facilities) {
    const hospitalId = hospitals.ids.get(p.facility.code);
    if (!hospitalId) {
      p.rows.forEach((r) => report.fail(r, 'ELEVATE_REFUSED', `ELEVATE did not create hospital ${p.facility.code}`));
      continue;
    }
    const wardRows = [...p.wards.values()].filter((w) => {
      if (wards.ids.has(w.code)) return true;
      report.fail(w.row, 'ELEVATE_REFUSED', `ELEVATE did not create ward ${w.code}`);
      return false;
    });
    try {
      const r = await d.register.upsertFacility({
        facilityCode: p.facility.code, elevateEntityId: hospitalId, name: p.facility.name, districtCode: p.facility.districtCode,
        level: p.facility.level, location: p.facility.location, status: p.facility.status,
        wards: wardRows.map((w) => ({ wardCode: w.code, elevateEntityId: wards.ids.get(w.code)!, name: w.name, wardType: w.type, active: w.active })),
        reason: 'facility import',
      });
      if (r.created) report.counts.created += 1;
      else if (r.changed) report.counts.updated += 1;
      for (const w of r.wards) {
        if (w.created) report.counts.created += 1;
        else if (w.changed) report.counts.updated += 1;
      }
    } catch (e) {
      const code = e instanceof RegisterRowError ? e.code : 'REGISTER_UNAVAILABLE';
      p.rows.forEach((r) => report.fail(r, code, (e as Error).message));
    }
  }
  return report;
}
