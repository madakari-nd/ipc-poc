import { defineConfig } from 'vitest/config';

// Coverage gate (Constitution XI): Workflow and Edge business modules >= 80% lines.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'services/workflow/src/domain/**',
        'services/edge/src/{scope,middleware,evidence,session}/**',
      ],
      thresholds: { lines: 80 },
      reporter: ['text', 'json-summary', 'html'],
    },
  },
});
