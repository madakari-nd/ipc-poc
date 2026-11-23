import { createEventValidator } from '@ipc/contracts';
import { ClockService } from './clock/clock.js';
import type { Profile } from './domain/clock.js';
import { LedgerService } from './ledger/ledger.service.js';
import { Outbox } from './services/outbox.publisher.js';
import { ScopeService } from './services/scope.service.js';

export interface WorkflowContext {
  clock: ClockService;
  ledger: LedgerService;
  outbox: Outbox;
  scope: ScopeService;
}

/** Composition root for domain services (server, scripts and tests share it). */
export function createContext(o: { profile: Profile; demoMode: boolean }): WorkflowContext {
  const clock = new ClockService({ profile: o.profile, demoMode: o.demoMode });
  const ledger = new LedgerService(() => clock.programmeNow());
  clock.attachLedger(ledger);
  const outbox = new Outbox({ profile: o.profile, validator: createEventValidator(), programmeNow: () => clock.programmeNow() });
  const scope = new ScopeService(ledger);
  return { clock, ledger, outbox, scope };
}
