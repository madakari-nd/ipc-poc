// Adapters-owned import collections (US1 T069/T070): import jobs (status for getImport) and the HR
// staff map (staff id -> ELEVATE user id; makes the HR import idempotent by staff code).
// Reversible: `down` drops exactly these indexes and removes a collection only when it is empty.
// This file is a frozen snapshot: never edit it after release, add a new migration instead.

const COLLECTIONS = {
  import_jobs: [{ name: 'import_kind_created', key: { kind: 1, createdAt: -1 } }],
  hr_staff: [
    { name: 'hr_staff_id_unique', key: { staffId: 1 }, unique: true },
    { name: 'hr_staff_user', key: { elevateUserId: 1 } },
  ],
};

async function existing(db) {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
}

module.exports = {
  COLLECTIONS,

  async up(db) {
    const have = await existing(db);
    for (const [name, indexes] of Object.entries(COLLECTIONS)) {
      if (!have.has(name)) await db.createCollection(name);
      for (const { key, ...opts } of indexes) await db.collection(name).createIndex(key, opts);
    }
  },

  async down(db) {
    const have = await existing(db);
    for (const [name, indexes] of Object.entries(COLLECTIONS)) {
      if (!have.has(name)) continue;
      const coll = db.collection(name);
      const present = new Set((await coll.indexes()).map((i) => i.name));
      for (const { name: indexName } of indexes) if (present.has(indexName)) await coll.dropIndex(indexName);
      if ((await coll.countDocuments({}, { limit: 1 })) === 0) await coll.drop();
    }
  },
};
