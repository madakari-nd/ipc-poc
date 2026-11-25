import { createEventValidator } from '@ipc/contracts';
import { ClockService } from './clock/clock.js';
import type { Profile } from './domain/clock.js';
import { LedgerService } from './ledger/ledger.service.js';
import { Outbox } from './services/outbox.publisher.js';
import { ScopeService } from './services/scope.service.js';
import { AdminService } from './services/admin.service.js';
import { CatalogueService } from './services/catalogue.service.js';
import { UnconfiguredElevateAdmin, type ElevateAdminPort } from './services/elevate-admin.gateway.js';
import { EscalationService } from './services/escalation.service.js';
import { NotificationService, type EmailSender } from './services/notification.service.js';
import { HomeService } from './services/home.service.js';
import { RetentionService } from './services/retention.service.js';

export interface WorkflowContext {
  clock: ClockService;
  ledger: LedgerService;
  outbox: Outbox;
  scope: ScopeService;
  catalogue: CatalogueService;
  admin: AdminService;
  notifications: NotificationService;
  escalations: EscalationService;
  home: HomeService;
  retention: RetentionService;
}

/** Composition root for domain services (server, scripts and tests share it). */
export function createContext(o: {
  profile: Profile;
  demoMode: boolean;
  elevate?: ElevateAdminPort;
  codePrefix?: string;
  /** ELEVATE notification client; absent → email notifications stay `queued` (demo never blocks). */
  email?: EmailSender;
  /** ELEVATE user id → email, for the escalation email channel (FR-021). */
  emailOf?: (userId: string) => Promise<string | undefined>;
}): WorkflowContext {
  const clock = new ClockService({ profile: o.profile, demoMode: o.demoMode });
  const ledger = new LedgerService(() => clock.programmeNow());
  clock.attachLedger(ledger);
  const outbox = new Outbox({ profile: o.profile, validator: createEventValidator(), programmeNow: () => clock.programmeNow() });
  const scope = new ScopeService(ledger);
  const elevate = o.elevate ?? new UnconfiguredElevateAdmin(['ELEVATE_* settings']);
  const catalogue = new CatalogueService({ ledger, outbox, elevate, programmeNow: () => clock.programmeNow(), prefix: o.codePrefix });
  const notifications = new NotificationService({ outbox, email: o.email, logger: undefined });
  const escalations = new EscalationService({ ledger, outbox, programmeNow: () => clock.programmeNow(), notifications, ...(o.emailOf ? { emailOf: o.emailOf } : {}) });
  const home = new HomeService(() => clock.programmeNow());
  const retention = new RetentionService({ ledger, profile: o.profile });
  const admin = new AdminService({ ledger, scope, catalogue, elevate, profile: o.profile, demoMode: () => clock.allowed, retention });
  return { clock, ledger, outbox, scope, catalogue, admin, notifications, escalations, home, retention };
}
