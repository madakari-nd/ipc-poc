import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'workflow',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Mongo-backed tests start a MongoMemoryReplSet (transactions need a replica set).
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
