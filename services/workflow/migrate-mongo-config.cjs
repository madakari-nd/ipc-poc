// migrate-mongo configuration for the workflow database `ipc_<profile>` (research T12, NFR-006).
// Run with the Mongo admin URL (migrations create collections, indexes and the app role):
//   MONGO_URL=... IPC_PROFILE=dev npm run migrate:up -w @ipc/workflow
const profile = process.env.IPC_PROFILE || 'dev';
if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL is required to run workflow migrations');
}

module.exports = {
  mongodb: {
    url: process.env.MONGO_URL,
    databaseName: process.env.MONGO_DB || `ipc_${profile}`,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migrations_changelog',
  lockCollectionName: 'migrations_lock',
  lockTtl: 300,
  migrationFileExtension: '.cjs',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
