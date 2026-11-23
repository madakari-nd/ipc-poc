import { defineWorkspace } from 'vitest/config';

// Unit + contract tests run on hosted CI. "integration" and "security" hit the REAL local ELEVATE
// (Constitution I) and run only on the self-hosted runner.
export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'services/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
  { test: { name: 'integration', include: ['tests/integration/**/*.int.test.ts'], testTimeout: 60_000 } },
  { test: { name: 'security', include: ['tests/security/**/*.sec.test.ts'], testTimeout: 60_000 } },
]);
