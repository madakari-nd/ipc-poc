// 0002: the application's database role (research T12, Constitution IV). The workflow app may only
// insert into and read `ledger` (no update, no remove), so "append-only" holds at the database too.
// Every other workflow collection gets find/insert/update/remove; nothing gets drop or index rights.
// When WORKFLOW_DB_APP_USER and WORKFLOW_DB_APP_PASSWORD are set, the app user is created with only
// this role; point the workflow MONGO_URL at that user. Reversible: `down` drops the user and role.
// Frozen snapshot: never edit after release.

const ROLE = 'ipcWorkflowApp';

const READ_WRITE = [
  'programmes', 'facilities', 'wards', 'cycles', 'scope_assignments', 'checklist_versions', 'risk_defaults',
  'escalation_rules', 'assessment_contexts', 'plans', 'plan_revisions', 'tasks', 'decisions', 'escalations',
  'notifications', 'mentor_profile_cache', 'support_requests', 'counters', 'retention_policy', 'outbox_events',
  'consumed_events', 'dead_letters', 'clock_settings', 'internal_idempotency',
];

function privileges(dbName) {
  return [
    { resource: { db: dbName, collection: 'ledger' }, actions: ['find', 'insert'] },
    ...READ_WRITE.map((collection) => ({
      resource: { db: dbName, collection },
      actions: ['find', 'insert', 'update', 'remove'],
    })),
    // Driver/ODM housekeeping only (no data access).
    { resource: { db: dbName, collection: '' }, actions: ['listCollections', 'listIndexes', 'collStats'] },
  ];
}

async function roleExists(db) {
  const info = await db.command({ rolesInfo: ROLE });
  return info.roles.length > 0;
}

async function userExists(db, user) {
  const info = await db.command({ usersInfo: user });
  return info.users.length > 0;
}

module.exports = {
  ROLE,
  READ_WRITE,

  async up(db) {
    const privs = privileges(db.databaseName);
    if (await roleExists(db)) await db.command({ updateRole: ROLE, privileges: privs, roles: [] });
    else await db.command({ createRole: ROLE, privileges: privs, roles: [] });

    const user = process.env.WORKFLOW_DB_APP_USER;
    const pwd = process.env.WORKFLOW_DB_APP_PASSWORD;
    if (user && pwd) {
      const roles = [{ role: ROLE, db: db.databaseName }];
      if (await userExists(db, user)) await db.command({ updateUser: user, pwd, roles });
      else await db.command({ createUser: user, pwd, roles });
    }
  },

  async down(db) {
    const user = process.env.WORKFLOW_DB_APP_USER;
    if (user && (await userExists(db, user))) await db.command({ dropUser: user });
    if (await roleExists(db)) await db.command({ dropRole: ROLE });
  },
};
