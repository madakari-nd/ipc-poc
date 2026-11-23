// Edge-owned collections and their indexes (data-model §7, T029). Reversible: `down` drops exactly
// the indexes created here and removes a collection only when it is still empty.
const SEVEN_DAYS = 7 * 24 * 60 * 60;

const SPEC = {
  sessions: [
    { key: { sid: 1 }, name: 'sid_unique', unique: true },
    { key: { userId: 1 }, name: 'userId' },
    // Idle / device expiry: Mongo removes the session once expiresAt passes.
    { key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 },
  ],
  idempotency_records: [
    { key: { userId: 1, key: 1 }, name: 'user_key_unique', unique: true },
    { key: { createdAt: 1 }, name: 'createdAt_ttl_7d', expireAfterSeconds: SEVEN_DAYS },
  ],
  evidence_items: [
    { key: { objectKey: 1 }, name: 'objectKey_unique', unique: true },
    { key: { facilityId: 1, wardId: 1 }, name: 'facility_ward' },
    { key: { sha256: 1 }, name: 'sha256' },
    { key: { 'link.type': 1, 'link.id': 1, sha256: 1 }, name: 'link_sha256' },
    { key: { uploadedBy: 1, state: 1 }, name: 'uploader_state' },
    { key: { state: 1, receivedAt: -1 }, name: 'state_receivedAt' },
  ],
  purge_list: [
    { key: { objectKey: 1 }, name: 'objectKey_unique', unique: true },
    { key: { deletedAt: 1 }, name: 'deletedAt' },
  ],
  device_queue_status: [
    { key: { deviceId: 1, userId: 1 }, name: 'device_user_unique', unique: true },
    { key: { oldestPendingAt: 1 }, name: 'oldestPendingAt' },
  ],
  offline_key_salts: [{ key: { userId: 1 }, name: 'userId_unique', unique: true }],
  rate_limits: [{ key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 }],
};

module.exports = {
  SPEC,
  async up(db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const [name, indexes] of Object.entries(SPEC)) {
      if (!existing.has(name)) await db.createCollection(name);
      await db.collection(name).createIndexes(indexes);
    }
  },
  async down(db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const [name, indexes] of Object.entries(SPEC)) {
      if (!existing.has(name)) continue;
      const col = db.collection(name);
      for (const ix of indexes) {
        const present = await col.indexExists(ix.name);
        if (present) await col.dropIndex(ix.name);
      }
      if ((await col.estimatedDocumentCount()) === 0) await col.drop();
    }
  },
};
