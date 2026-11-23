import type { components } from '@ipc/contracts';

export type Me = components['schemas']['Me'];
export type Role = components['schemas']['Role'];
export type HomeSummary = components['schemas']['HomeSummary'];
export type HomeCardKind = HomeSummary['cards'][number]['kind'];
export type SessionResponse = components['schemas']['Session'];
