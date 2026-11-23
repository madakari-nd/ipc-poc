import { describe, expect, it } from 'vitest';
import tokens from '../tokens.json';
import { contrastRatio } from '../src/contrast.js';
import { LEGEND_KINDS, RISK_LEVELS, TASK_STATES, stateSlug } from '../src/tokens.js';

type Pair = { fg: string; bg: string; hover?: string };

const groups = ['action', 'feedback', 'state', 'risk', 'legend'] as const;

describe('colour contrast (WCAG 2.2 AA, >= 4.5:1)', () => {
  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  for (const g of groups) {
    for (const [name, pair] of Object.entries(tokens.color[g] as Record<string, Pair>)) {
      it(`${g}.${name} fg on bg`, () => {
        expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(4.5);
      });
      if (pair.hover) {
        it(`${g}.${name} fg on hover`, () => {
          expect(contrastRatio(pair.fg, pair.hover as string)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('body and muted text on surfaces', () => {
    const b = tokens.color.base;
    for (const bg of [b.surface, b['surface-muted']]) {
      expect(contrastRatio(b.text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(b['text-muted'], bg)).toBeGreaterThanOrEqual(4.5);
    }
    // Non-text UI (input borders, focus ring) needs >= 3:1 (WCAG 1.4.11).
    expect(contrastRatio(b.border, b.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(b.focus, b.surface)).toBeGreaterThanOrEqual(3);
  });
});

describe('semantic coverage', () => {
  it('has one token per task state, risk level and legend kind', () => {
    for (const s of TASK_STATES) expect(tokens.color.state[stateSlug(s)]).toBeDefined();
    expect(Object.keys(tokens.color.state)).toHaveLength(7);
    for (const r of RISK_LEVELS) expect(tokens.color.risk[r]).toBeDefined();
    for (const l of LEGEND_KINDS) expect(tokens.color.legend[l]).toBeDefined();
  });

  it('uses a 4 px spacing scale', () => {
    for (const v of Object.values(tokens.space)) expect(parseInt(v, 10) % 4).toBe(0);
  });
});
