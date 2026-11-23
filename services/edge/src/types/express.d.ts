import type { SessionDoc } from '../db/models.js';
import type { CallerScope, ScopedResource } from '../scope/types.js';
import type { OperationInfo } from '../openapi/operations.js';

declare global {
  namespace Express {
    interface Request {
      /** Contract operation matched by the edge route allow-list. */
      operation?: OperationInfo;
      /** BFF session (set by the session middleware). */
      session?: SessionDoc;
      /** Server-derived scope (set by the scope middleware, Constitution III). */
      scope?: CallerScope;
      /** Names of client-sent scope/role/profile/targeting fields that were removed. */
      strippedFields?: string[];
      /** Parsed If-Match version. */
      ifMatch?: number;
      /** Resource the ownership guard resolved and admitted. */
      resource?: ScopedResource & { doc?: unknown };
      /** Service JWT claims on the private listener. */
      service?: { sub?: string };
    }
  }
}

export {};
