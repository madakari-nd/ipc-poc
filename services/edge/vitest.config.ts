import { defineProject } from 'vitest/config';

// Supertest suites compile the full OpenAPI contract per app; under parallel coverage runs that
// can exceed the 5 s default.
export default defineProject({
  test: { name: 'edge', include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000 },
});
