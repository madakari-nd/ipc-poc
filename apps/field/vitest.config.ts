import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'field', include: ['tests/**/*.test.{ts,tsx}'], environment: 'jsdom' } });
