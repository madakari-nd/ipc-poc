import type { Request, Response } from 'express';
import { z } from 'zod';
import { ACTOR_ROLES, LEDGER_SUBJECT_TYPES } from '../domain/models/index.js';
import { toLedgerRecordDto, type LedgerService } from '../ledger/ledger.service.js';
import { parseOrThrow } from './validate.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** contracts LedgerAppendRequest (additionalProperties: false at every level). */
export const ledgerAppendRequest = z
  .object({
    actor: z.object({ userId: z.string().min(1).max(64), role: z.enum(ACTOR_ROLES) }).strict(),
    action: z.string().max(64).regex(/^[a-z_]+\.[a-z_]+$/),
    subject: z.object({ type: z.enum(LEDGER_SUBJECT_TYPES), id: z.string().min(1).max(64) }).strict(),
    reason: z.string().max(500).optional(),
    beforeHash: sha256.optional(),
    afterHash: sha256.optional(),
    correlationId: z.string().min(1).max(64),
  })
  .strict();

export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  /** internalAppendLedger: seq, at, programmeAt, prevHash and hash are assigned here, never by the caller. */
  append = async (req: Request, res: Response) => {
    const body = parseOrThrow(ledgerAppendRequest, req.body);
    const rec = await this.ledger.appendNow(body);
    res.status(201).json(toLedgerRecordDto(rec));
  };
}
