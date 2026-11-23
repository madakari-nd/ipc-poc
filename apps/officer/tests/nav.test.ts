import { describe, expect, it } from 'vitest';
import { CARD_SECTION, OFFICER_NAV, SECTIONS, canSee, canUseOfficerWeb, navFor } from '../src/lib/nav.js';
import type { Role } from '../src/lib/types.js';

const ALL: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR'];

describe('officer role navigation (FR-036)', () => {
  it('serves six roles; frontline staff are sent to the field app', () => {
    expect(ALL.filter(canUseOfficerWeb)).toHaveLength(6);
    expect(canUseOfficerWeb('FRONTLINE')).toBe(false);
  });
  it('starts every role on its home', () => {
    for (const r of ALL.filter(canUseOfficerWeb)) expect(navFor(r)[0]?.path).toBe('/');
  });
  it('only uses known sections', () => {
    for (const items of Object.values(OFFICER_NAV)) for (const i of items ?? []) expect(i.section === 'home' || SECTIONS.includes(i.section)).toBe(true);
    for (const s of Object.values(CARD_SECTION)) expect(SECTIONS).toContain(s);
  });
  it('keeps validation with IPC officers and district quality managers, and setup with the state administrator', () => {
    expect(ALL.filter((r) => canSee(r, 'validations')).sort()).toEqual(['DISTRICT_QM', 'IPC_OFFICER']);
    expect(ALL.filter((r) => canSee(r, 'admin'))).toEqual(['STATE_ADMIN']);
  });
  it('gives the external auditor read-only areas only', () => {
    expect(navFor('EXTERNAL_AUDITOR').map((n) => n.section)).toEqual(['home', 'plans', 'ledger']);
  });
});
