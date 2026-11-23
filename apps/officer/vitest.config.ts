import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'officer', include: ['tests/**/*.test.{ts,tsx}'], environment: 'jsdom' } });
