// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssVariables } from '../src/tokens.js';
import preset from '../src/tailwind-preset.js';

const css = readFileSync(new URL('../src/css/variables.css', import.meta.url), 'utf8');

describe('CSS variables and Tailwind preset follow tokens.json', () => {
  it('declares every token as a CSS variable with the same value', () => {
    const vars = cssVariables();
    expect(Object.keys(vars).length).toBeGreaterThan(50);
    for (const [name, value] of Object.entries(vars)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  it('exposes semantic colours and the 44 px touch size in the preset', () => {
    const colors = preset.theme.colors as Record<string, unknown>;
    expect(colors.state).toHaveProperty('pending-validation');
    expect(colors.risk).toHaveProperty('critical');
    expect(colors.legend).toHaveProperty('built-on-top');
    expect(preset.theme.extend.minHeight.touch).toBe('44px');
  });
});
