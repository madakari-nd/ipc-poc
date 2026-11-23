import { defineProject } from 'vitest/config';

export default defineProject({
  esbuild: { jsx: 'automatic' },
  test: { name: 'design-system', include: ['tests/**/*.test.{ts,tsx}'], environment: 'jsdom' },
});
