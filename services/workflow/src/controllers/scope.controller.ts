import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ScopeService } from '../services/scope.service.js';
import { parseOrThrow } from './validate.js';

const params = z.object({ userId: z.string().min(1).max(64) });

export class ScopeController {
  constructor(private readonly scope: ScopeService) {}

  /** internalGetEffectiveScope */
  getEffective = async (req: Request, res: Response) => {
    const { userId } = parseOrThrow(params, req.params);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json(await this.scope.effective(userId));
  };
}
