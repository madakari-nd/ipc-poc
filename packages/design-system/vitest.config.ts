import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'design-system', include: ['tests/**/*.test.{ts,tsx}'], environment: 'jsdom' } });
