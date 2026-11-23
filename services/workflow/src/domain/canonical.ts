import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted (code-unit order) at every level, `undefined` members dropped,
 * Dates as ISO-8601 UTC, no whitespace. Deterministic input for hashes (ledger chain, request hashes).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('canonicalJson: invalid Date');
    return JSON.stringify(value.toISOString());
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 of the canonical JSON of a value (beforeHash / afterHash / request hashes). */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
