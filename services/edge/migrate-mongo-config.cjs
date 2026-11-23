// migrate-mongo setup for the edge database `edge_<profile>` (T029, research T12).
// Usage: npm run migrate:up -w @ipc/edge  /  npm run migrate:down -w @ipc/edge
const profile = process.env.IPC_PROFILE;
if (!profile) throw new Error('IPC_PROFILE is required');
if (!process.env.MONGO_URL) throw new Error('MONGO_URL is required');

module.exports = {
  mongodb: {
    url: process.env.MONGO_URL,
    databaseName: `edge_${profile}`,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'changelog',
  lockCollectionName: 'changelog_lock',
  lockTtl: 300,
  migrationFileExtension: '.cjs',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
