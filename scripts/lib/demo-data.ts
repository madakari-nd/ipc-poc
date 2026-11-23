/**
 * FR-039 demo state as data: places, people, catalogue, plan template and rules. The ELEVATE codes
 * get the profile/generation prefix at run time (`p`), e.g. `TEST-HOSP-A`.
 */
import type { RiskLevel } from '../../services/workflow/src/domain/models/catalogue.js';
import type { Role } from '../../services/workflow/src/domain/scope.js';

export interface DistrictDef { key: string; code: (p: string) => string; name: string }
export interface WardDef { key: string; code: (p: string) => string; name: string; wardType: string }
export interface HospitalDef {
  key: string; code: (p: string) => string; name: string; district: string;
  location: { lat: number; lng: number }; wards: WardDef[];
}

export const STATE = { code: (p: string) => `${p}STATE-KA`, name: 'Karnataka (demo state)' };

export const DISTRICTS: DistrictDef[] = [
  { key: 'D1', code: (p) => `${p}D1`, name: 'District 1' },
  { key: 'D2', code: (p) => `${p}D2`, name: 'District 2' },
];

const ward = (h: string, key: string, name: string, wardType: string): WardDef =>
  ({ key: `${h}-${key}`, code: (p) => `${p}${h}-${key}`, name, wardType });

export const HOSPITALS: HospitalDef[] = [
  {
    key: 'HA', code: (p) => `${p}HOSP-A`, name: 'Hospital A (District 1)', district: 'D1',
    location: { lat: 12.9716, lng: 77.5946 },
    wards: [ward('HA', 'W1', 'Ward 1', 'general'), ward('HA', 'W4', 'Ward 4', 'general'), ward('HA', 'ICU', 'ICU', 'ICU')],
  },
  {
    key: 'HB', code: (p) => `${p}HOSP-B`, name: 'Hospital B (District 2)', district: 'D2',
    location: { lat: 15.3647, lng: 75.124 },
    wards: [ward('HB', 'W1', 'Ward 1', 'general'), ward('HB', 'W2', 'Ward 2', 'general'), ward('HB', 'ICU', 'ICU', 'ICU')],
  },
];
export const WARD4_KEY = 'HA-W4';

export const ALL_WARDS = HOSPITALS.flatMap((h) => h.wards.map((w) => ({ ...w, hospital: h })));

/** Programme scope of a person, resolved to ids by the seed. */
export type ScopeDef =
  | { level: 'state' }
  | { level: 'district'; district: string }
  | { level: 'facility'; hospital: string }
  | { level: 'facility_list'; hospitals: string[] }
  | { level: 'wards'; hospital: string; wards: string[] }
  | { level: 'own_tasks' };

export interface PersonDef {
  slug: string; name: string; role: Role; elevateRole: string; scope: ScopeDef;
  mentor?: { skills: string[]; languages: string[]; about: string; years: number };
}

/** Display names: ELEVATE accepts letters and spaces only, so the prefix is the word "TEST". */
export const PEOPLE: PersonDef[] = [
  { slug: 'state-admin', name: 'Meera Iyer', role: 'STATE_ADMIN', elevateRole: 'program_manager', scope: { level: 'state' } },
  { slug: 'qm-d1', name: 'Rahul Verma', role: 'DISTRICT_QM', elevateRole: 'program_manager', scope: { level: 'district', district: 'D1' } },
  { slug: 'qm-d2', name: 'Sunita Rao', role: 'DISTRICT_QM', elevateRole: 'program_manager', scope: { level: 'district', district: 'D2' } },
  { slug: 'officer-a', name: 'Asha Nair', role: 'IPC_OFFICER', elevateRole: 'user', scope: { level: 'facility', hospital: 'HA' } },
  { slug: 'supervisor-a', name: 'Leela Das', role: 'WARD_SUPERVISOR', elevateRole: 'user', scope: { level: 'wards', hospital: 'HA', wards: ['HA-W1', 'HA-W4', 'HA-ICU'] } },
  { slug: 'frontline-a1', name: 'Ravi Kumar', role: 'FRONTLINE', elevateRole: 'user', scope: { level: 'wards', hospital: 'HA', wards: ['HA-W4'] } },
  { slug: 'frontline-a2', name: 'Fatima Begum', role: 'FRONTLINE', elevateRole: 'user', scope: { level: 'wards', hospital: 'HA', wards: ['HA-W4', 'HA-W1'] } },
  { slug: 'officer-b', name: 'Vikram Singh', role: 'IPC_OFFICER', elevateRole: 'user', scope: { level: 'facility', hospital: 'HB' } },
  { slug: 'supervisor-b', name: 'Anita Joseph', role: 'WARD_SUPERVISOR', elevateRole: 'user', scope: { level: 'wards', hospital: 'HB', wards: ['HB-W1', 'HB-W2', 'HB-ICU'] } },
  { slug: 'frontline-b1', name: 'Suresh Patil', role: 'FRONTLINE', elevateRole: 'user', scope: { level: 'wards', hospital: 'HB', wards: ['HB-W1'] } },
  { slug: 'frontline-b2', name: 'Kavita Shetty', role: 'FRONTLINE', elevateRole: 'user', scope: { level: 'wards', hospital: 'HB', wards: ['HB-W2'] } },
  { slug: 'auditor', name: 'Kiran Shah', role: 'EXTERNAL_AUDITOR', elevateRole: 'reviewer', scope: { level: 'facility_list', hospitals: ['HA', 'HB'] } },
  {
    slug: 'mentor-hh', name: 'Priya Menon', role: 'MENTOR', elevateRole: 'mentor', scope: { level: 'own_tasks' },
    mentor: { skills: ['hand_hygiene'], languages: ['hi', 'en'], about: 'Hand hygiene expert, Hindi', years: 12 },
  },
  {
    slug: 'mentor-waste', name: 'John Mathew', role: 'MENTOR', elevateRole: 'mentor', scope: { level: 'own_tasks' },
    mentor: { skills: ['waste'], languages: ['en'], about: 'Biomedical waste expert, English', years: 9 },
  },
  {
    slug: 'mentor-ppe', name: 'Kavya Rao', role: 'MENTOR', elevateRole: 'mentor', scope: { level: 'own_tasks' },
    mentor: { skills: ['ppe', 'cleaning'], languages: ['kn', 'en'], about: 'PPE and cleaning expert, Kannada', years: 7 },
  },
];

/** Assessors get one observation per cycle solution with every ward in their scope (E6). */
export const ASSESSORS: { slug: string; wards: string[]; type: 'internal' | 'external' }[] = [
  { slug: 'officer-a', wards: ['HA-W1', 'HA-W4', 'HA-ICU'], type: 'internal' },
  { slug: 'officer-b', wards: ['HB-W1', 'HB-W2', 'HB-ICU'], type: 'internal' },
  { slug: 'auditor', wards: ALL_WARDS.map((w) => w.key), type: 'external' },
];

export const serviceSlug = (wardKey: string) => `svc-${wardKey.toLowerCase()}`;
const WORD: Record<string, string> = { W1: 'One', W2: 'Two', W4: 'Four', ICU: 'ICU' };
export const serviceName = (wardKey: string) => {
  const [h, w] = wardKey.split('-') as [string, string];
  return `Ward Service ${h === 'HA' ? 'Hospital A' : 'Hospital B'} ${w === 'ICU' ? 'ICU' : `Ward ${WORD[w] ?? w}`}`;
};

// ---- Checklist catalogue (programme side). The ELEVATE form is the lab sample solution copied
// with importFromSolution; its question wording is not IPC wording (SUP authoring is a later step),
// so the catalogue gives each samiksha question a stable programme key and IPC meaning.
export interface CatalogueQuestionDef {
  questionKey: string; title: string; sectionKey: string; riskLevel: RiskLevel; templateTaskKey: string;
}
// The lab sample form has 2 answerable questions (radio, multiselect), mapped in this order; the
// remaining keys apply when an authored form has more.
export const CATALOGUE: CatalogueQuestionDef[] = [
  { questionKey: 'hand_rub_at_bed', title: 'Alcohol hand-rub available at every bed', sectionKey: 'hand_hygiene', riskLevel: 'critical', templateTaskKey: 'fit-hand-rub-dispensers' },
  { questionKey: 'waste_segregation', title: 'Biomedical waste segregated at source', sectionKey: 'environment', riskLevel: 'normal', templateTaskKey: 'segregate-waste-at-source' },
  { questionKey: 'hh_posters', title: 'Hand hygiene posters displayed at entry and sinks', sectionKey: 'hand_hygiene', riskLevel: 'high', templateTaskKey: 'display-hand-hygiene-posters' },
  { questionKey: 'surface_cleaning', title: 'High-touch surfaces cleaned on schedule', sectionKey: 'environment', riskLevel: 'normal', templateTaskKey: 'clean-high-touch-surfaces' },
];
export const SECTIONS = [
  { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene', hi: 'हाथ की स्वच्छता', kn: 'ಕೈ ನೈರ್ಮಲ್ಯ' }, wardTypes: ['general', 'ICU'] },
  { sectionKey: 'environment', title: { en: 'Environment and waste', hi: 'पर्यावरण और अपशिष्ट', kn: 'ಪರಿಸರ ಮತ್ತು ತ್ಯಾಜ್ಯ' }, wardTypes: ['general', 'ICU'] },
];
/** Each question is pass/fail in the programme: maxScore 10, pass mark 10. */
export const QUESTION_MAX = 10;

export const PLAN_TASKS: { key: string; title: string }[] = [
  { key: 'fit-hand-rub-dispensers', title: 'Fit hand-rub dispensers at every bed' },
  { key: 'display-hand-hygiene-posters', title: 'Display hand hygiene posters at entry and sinks' },
  { key: 'segregate-waste-at-source', title: 'Segregate biomedical waste at source' },
  { key: 'clean-high-touch-surfaces', title: 'Clean high-touch surfaces on schedule' },
];

// ---- Cycles (C0 is back-dated and closed; C1 is active)
export const CYCLES = [
  { code: '2026-C0', status: 'closed' as const, startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-10-31T23:59:59Z', baselineBy: '2026-08-31T00:00:00Z', repeatBy: '2026-10-15T00:00:00Z' },
  { code: '2026-C1', status: 'active' as const, startsAt: '2026-11-01T00:00:00Z', endsAt: '2027-02-28T23:59:59Z', baselineBy: '2026-12-15T00:00:00Z', repeatBy: '2027-02-15T00:00:00Z' },
];

/** C0 baselines (US7/US8): which catalogue questions pass. Ward 4 fails the critical one. */
export const C0_BASELINES: { ward: string; completedAt: string; pass: Record<string, boolean> }[] = [
  { ward: 'HA-W4', completedAt: '2026-09-15T10:30:00Z', pass: { hand_rub_at_bed: false, waste_segregation: false, hh_posters: true, surface_cleaning: true } },
  { ward: 'HA-W1', completedAt: '2026-09-18T11:00:00Z', pass: { hand_rub_at_bed: true, waste_segregation: false, hh_posters: true, surface_cleaning: true } },
];

export const RISK_DEFAULTS = [
  { riskLevel: 'critical' as const, dueDays: 7, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true },
  { riskLevel: 'high' as const, dueDays: 14, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true },
  { riskLevel: 'normal' as const, dueDays: 30, evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false },
];

/** Proposal A11 defaults. */
export const ESCALATION_RULES = [
  { code: 'R1', condition: { type: 'overdue' as const, riskLevels: ['critical' as const], thresholdHours: 48 }, target: { mode: 'role' as const, role: 'IPC_OFFICER' }, channels: ['inapp' as const, 'email' as const], active: true },
  { code: 'R2', condition: { type: 'overdue' as const, riskLevels: ['critical' as const], thresholdHours: 168 }, target: { mode: 'role' as const, role: 'DISTRICT_QM' }, channels: ['inapp' as const, 'email' as const], active: true },
  { code: 'R3', condition: { type: 'rejections' as const, riskLevels: ['critical' as const, 'high' as const, 'normal' as const], thresholdCount: 2 }, target: { mode: 'level_above_decider' as const }, channels: ['inapp' as const, 'email' as const], active: true },
];
