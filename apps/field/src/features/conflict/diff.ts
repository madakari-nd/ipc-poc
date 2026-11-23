export interface DiffRow {
  field: string;
  mine: unknown;
  server: unknown;
  /** True when the server's current value differs from what the user wants to set. */
  differs: boolean;
}

export function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One row per field of the user's change set, against the server's current version. */
export function diffChangeSet(mine: Record<string, unknown>, current: Record<string, unknown>): DiffRow[] {
  return Object.keys(mine).map((field) => ({ field, mine: mine[field], server: current[field], differs: !isEqual(mine[field], current[field]) }));
}

/** The body to re-apply: the user's values for kept fields; fields given up to the server are dropped. */
export function reapplyBody(mine: Record<string, unknown>, keep: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mine).filter(([k]) => keep.has(k)));
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
