import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'elevate-client', include: ['tests/**/*.test.ts'], environment: 'node' } });
