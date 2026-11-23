import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'workflow', include: ['tests/**/*.test.ts'], environment: 'node' } });
