import { describe, expect, it } from 'vitest';
import { canSee, canUseFieldApp, navFor } from '../src/lib/nav.js';
import type { Role } from '../src/lib/types.js';

const ALL: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR'];

describe('field role navigation (FR-036)', () => {
  it('lets only the four field roles in', () => {
    expect(ALL.filter(canUseFieldApp).sort()).toEqual(['EXTERNAL_AUDITOR', 'FRONTLINE', 'IPC_OFFICER', 'WARD_SUPERVISOR']);
  });
  it('gives every field role a home and the sync queue', () => {
    for (const r of ALL.filter(canUseFieldApp)) {
      expect(navFor(r)[0]?.section).toBe('home');
      expect(canSee(r, 'queue')).toBe(true);
    }
  });
  it('shows the review queue only to ward supervisors', () => {
    expect(ALL.filter((r) => canSee(r, 'reviews'))).toEqual(['WARD_SUPERVISOR']);
  });
});
