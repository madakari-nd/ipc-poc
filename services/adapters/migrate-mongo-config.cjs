// migrate-mongo setup for the adapters' collections in `ipc_<profile>` (research T12). The workflow
// migrations share this database, so the adapters keep their own changelog collection.
// Usage: npm run migrate:up -w @ipc/adapters  /  npm run migrate:down -w @ipc/adapters
const profile = process.env.IPC_PROFILE;
if (!profile) throw new Error('IPC_PROFILE is required');
if (!process.env.MONGO_URL) throw new Error('MONGO_URL is required');

module.exports = {
  mongodb: {
    url: process.env.MONGO_URL,
    databaseName: `ipc_${profile}`,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'changelog_adapters',
  lockCollectionName: 'changelog_adapters_lock',
  lockTtl: 300,
  migrationFileExtension: '.cjs',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
