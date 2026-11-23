import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import hi from '../src/i18n/hi.json';
import kn from '../src/i18n/kn.json';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

describe('translations (FR-035)', () => {
  it('Hindi is complete', () => {
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });
  it('Kannada is partial and only uses keys that exist in English (falls back to English)', () => {
    const enKeys = new Set(keys(en));
    expect(keys(kn).length).toBeGreaterThan(0);
    for (const k of keys(kn)) expect(enKeys.has(k)).toBe(true);
  });
  it('has no empty strings', () => {
    for (const lang of [en, hi, kn]) {
      for (const k of keys(lang)) {
        const v = k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], lang);
        expect(String(v).trim().length, k).toBeGreaterThan(0);
      }
    }
  });
});
