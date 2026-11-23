import type { HomeCardKind, Role } from './types.js';

export type Section =
  | 'home'
  | 'assessments'
  | 'plans'
  | 'tasks'
  | 'reviews'
  | 'validations'
  | 'escalations'
  | 'support'
  | 'oversight'
  | 'checklists'
  | 'admin'
  | 'ledger';

export interface NavItem {
  section: Section;
  path: string;
  labelKey: string;
}

const item = (section: Section): NavItem => ({ section, path: section === 'home' ? '/' : `/${section}`, labelKey: `nav.${section}` });

/** FR-036: officer web roles. Each sees only the areas it may act in; FRONTLINE uses the field app. */
export const OFFICER_NAV: Partial<Record<Role, NavItem[]>> = {
  STATE_ADMIN: [item('home'), item('oversight'), item('admin'), item('checklists'), item('ledger')],
  DISTRICT_QM: [item('home'), item('oversight'), item('validations'), item('escalations')],
  IPC_OFFICER: [item('home'), item('assessments'), item('plans'), item('validations'), item('support'), item('escalations')],
  WARD_SUPERVISOR: [item('home'), item('reviews'), item('tasks'), item('support')],
  MENTOR: [item('home'), item('support')],
  EXTERNAL_AUDITOR: [item('home'), item('plans'), item('ledger')],
};

export const SECTIONS: Section[] = ['assessments', 'plans', 'tasks', 'reviews', 'validations', 'escalations', 'support', 'oversight', 'checklists', 'admin', 'ledger'];

export function navFor(role: Role): NavItem[] {
  return OFFICER_NAV[role] ?? [];
}

export function canUseOfficerWeb(role: Role): boolean {
  return navFor(role).length > 0;
}

export function canSee(role: Role, section: Section): boolean {
  return navFor(role).some((n) => n.section === section);
}

export const CARD_SECTION: Partial<Record<HomeCardKind, Section>> = {
  assessments_due: 'assessments',
  held_results: 'assessments',
  draft_plans: 'plans',
  my_tasks: 'tasks',
  overdue_critical: 'tasks',
  needs_reassignment: 'tasks',
  review_queue: 'reviews',
  validation_queue: 'validations',
  escalations: 'escalations',
  support_requests: 'support',
  stale_devices: 'oversight',
  data_quality_exceptions: 'oversight',
  checklist_drafts: 'checklists',
  import_jobs: 'admin',
};
