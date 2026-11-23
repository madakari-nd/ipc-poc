import type { components } from '@ipc/contracts';

export type Me = components['schemas']['Me'];
export type Role = components['schemas']['Role'];
export type HomeSummary = components['schemas']['HomeSummary'];
export type HomeCardKind = HomeSummary['cards'][number]['kind'];
export type Language = components['schemas']['Language'];

/** Login response. `offlineKeySalt` (base64) is the server-provided PBKDF2 salt for the field app. */
export type SessionResponse = components['schemas']['Session'] & { offlineKeySalt?: string };
