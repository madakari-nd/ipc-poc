import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'adapters', include: ['tests/**/*.test.ts'], environment: 'node' } });
