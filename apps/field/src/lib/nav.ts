import type { HomeCardKind, Role } from './types.js';

/** Sections of the field app. Home and the sync queue are built; the others arrive with their journeys. */
export type Section = 'home' | 'tasks' | 'reviews' | 'assessments' | 'queue';

export interface NavItem {
  section: Section;
  path: string;
  labelKey: string;
}

const item = (section: Section): NavItem => ({
  section,
  path: section === 'home' ? '/' : `/${section}`,
  labelKey: `nav.${section}`,
});

/** FR-036: field roles are frontline staff, ward supervisor, IPC officer and external auditor. */
export const FIELD_NAV: Partial<Record<Role, NavItem[]>> = {
  FRONTLINE: [item('home'), item('tasks'), item('queue')],
  WARD_SUPERVISOR: [item('home'), item('reviews'), item('tasks'), item('queue')],
  IPC_OFFICER: [item('home'), item('assessments'), item('queue')],
  EXTERNAL_AUDITOR: [item('home'), item('assessments'), item('queue')],
};

export function navFor(role: Role): NavItem[] {
  return FIELD_NAV[role] ?? [];
}

export function canUseFieldApp(role: Role): boolean {
  return navFor(role).length > 0;
}

export function canSee(role: Role, section: Section): boolean {
  return navFor(role).some((n) => n.section === section);
}

/** Where a home card leads in this app (only when the role has that section). */
export const CARD_SECTION: Partial<Record<HomeCardKind, Section>> = {
  assessments_due: 'assessments',
  held_results: 'assessments',
  my_tasks: 'tasks',
  overdue_critical: 'tasks',
  needs_reassignment: 'tasks',
  review_queue: 'reviews',
};
