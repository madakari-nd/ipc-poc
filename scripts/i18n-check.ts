/**
 * T121 (FR-035): every user-facing English key must have a Hindi translation, and Kannada may be
 * partial (it falls back to English). Fails (exit 1) when:
 *   - a key exists in en.json but not in hi.json (missing translation), or
 *   - a key exists in hi.json but not en.json (orphan), or
 *   - a key is an empty string, or
 *   - a Kannada key does not exist in English (it can never resolve).
 *
 * Checks every app's i18n directory. Run: `npm run i18n:check` (added to CI).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['apps/officer', 'apps/field'];

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out.push(...keys(v as Record<string, unknown>, `${prefix}${k}.`));
    else out.push(`${prefix}${k}`);
  }
  return out;
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], obj);
}

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

function checkApp(app: string): string[] {
  const dir = join(ROOT, app, 'src/i18n');
  const errors: string[] = [];
  let en: Record<string, unknown>;
  let hi: Record<string, unknown>;
  let kn: Record<string, unknown>;
  try {
    en = json(join(dir, 'en.json'));
    hi = json(join(dir, 'hi.json'));
    kn = json(join(dir, 'kn.json'));
  } catch (err) {
    return [`${app}: missing i18n file — ${err instanceof Error ? err.message : String(err)}`];
  }
  const enKeys = keys(en);
  const hiKeys = new Set(keys(hi));
  const knKeys = new Set(keys(kn));

  for (const k of enKeys) {
    if (!hiKeys.has(k)) errors.push(`${app}: hi.json is missing "${k}"`);
    const v = resolvePath(en, k);
    if (typeof v === 'string' && v.trim().length === 0) errors.push(`${app}: en.json "${k}" is empty`);
  }
  for (const k of hiKeys) {
    if (!enKeys.includes(k)) errors.push(`${app}: hi.json has a key that en.json does not ("${k}")`);
    const v = resolvePath(hi, k);
    if (typeof v === 'string' && v.trim().length === 0) errors.push(`${app}: hi.json "${k}" is empty`);
  }
  for (const k of knKeys) {
    if (!enKeys.includes(k)) errors.push(`${app}: kn.json has a key that en.json does not ("${k}")`);
  }
  return errors;
}

const allErrors = APPS.flatMap(checkApp);
if (allErrors.length) {
  for (const e of allErrors) console.error(`✖ ${e}`);
  console.error(`i18n check failed with ${allErrors.length} problem(s).`);
  process.exit(1);
}
console.log(`i18n check passed for ${APPS.join(', ')} (English + Hindi complete, Kannada partial).`);
