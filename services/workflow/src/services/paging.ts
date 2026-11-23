import { Types } from 'mongoose';
import { Problem } from '@ipc/platform';

/** Cursor page (contract `Page`): `nextCursor` is null on the last page. */
export interface Page<T> { items: T[]; nextCursor: string | null }

/** Opaque cursor = base64url of the last item's ObjectId (lists are sorted by _id). */
export function encodeCursor(id: Types.ObjectId | string): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Types.ObjectId | undefined {
  if (!cursor) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[a-f0-9]{24}$/.test(raw)) throw Problem.badRequest('VALIDATION_FAILED', 'cursor is not valid');
  return new Types.ObjectId(raw);
}
