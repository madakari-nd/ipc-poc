import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type * from './generated.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Path to the OpenAPI document (used by request/response validators). */
export const openapiPath = join(root, 'openapi.yaml');

/** Parsed OpenAPI document. */
export function loadOpenApi(): Record<string, unknown> {
  return parse(readFileSync(openapiPath, 'utf8')) as Record<string, unknown>;
}

/** Event type names, e.g. "ipc.task.escalated". */
export const eventTypes: string[] = readdirSync(join(root, 'events'))
  .filter((f) => f.endsWith('.schema.json'))
  .map((f) => f.replace('.schema.json', ''));

export type EventValidator = (type: string, event: unknown) => { ok: true } | { ok: false; errors: string[] };

/** Builds a validator for ipc.* events against their JSON Schemas (validated before publish). */
export function createEventValidator(): EventValidator {
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validators = new Map(
    eventTypes.map((t) => [
      t,
      ajv.compile(JSON.parse(readFileSync(join(root, 'events', `${t}.schema.json`), 'utf8'))),
    ]),
  );
  return (type, event) => {
    const v = validators.get(type);
    if (!v) return { ok: false, errors: [`unknown event type ${type}`] };
    return v(event)
      ? { ok: true }
      : { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`) };
  };
}
