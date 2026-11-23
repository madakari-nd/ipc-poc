import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m0001, m0002, startMongo, type TestMongo } from '../helpers/mongo.js';

let mongo: TestMongo;
beforeAll(async () => { mongo = await startMongo('ipc_migrations_test'); });
afterAll(async () => { await mongo.stop(); });

async function indexNames(coll: string): Promise<string[]> {
  return (await mongo.db().collection(coll).indexes()).map((i) => i.name!);
}

describe('0001 collections + indexes', () => {
  it('creates every data-model index', async () => {
    expect(await indexNames('tasks')).toEqual(expect.arrayContaining(['task_plan_state', 'task_owner_state', 'task_sweep']));
    expect(await indexNames('ledger')).toEqual(expect.arrayContaining(['ledger_seq_unique', 'ledger_subject_seq']));
    expect(await indexNames('plans')).toEqual(expect.arrayContaining(['plan_ward_cycle_unique', 'plan_source_assessment_unique']));
    expect(await indexNames('assessment_contexts')).toEqual(expect.arrayContaining(['assessment_submission_unique', 'assessment_ward_cycle_completed']));
    expect(await indexNames('escalations')).toContain('escalation_task_rule_level_unique');
    expect(await indexNames('scope_assignments')).toContain('scope_user_validity');
    expect(await indexNames('consumed_events')).toContain('consumed_topic_key_status_unique');
  });

  it('is idempotent and reversible (down drops its indexes and empty collections)', async () => {
    await m0001.up(mongo.db());
    await mongo.db().collection('tasks').insertOne({ keep: true });
    await m0001.down(mongo.db());
    const names = (await mongo.db().listCollections().toArray()).map((c) => c.name);
    expect(names).toContain('tasks'); // not empty → kept
    expect(names).not.toContain('ledger');
    expect(await indexNames('tasks')).toEqual(['_id_']);
    await mongo.db().collection('tasks').deleteMany({});
    await m0001.up(mongo.db());
    expect(await indexNames('ledger')).toContain('ledger_seq_unique');
  });
});

describe('0002 app role: ledger is insert + find only', () => {
  it('creates the role with exactly find/insert on ledger and no drop anywhere; down removes it', async () => {
    const db = mongo.db();
    await m0002.up(db);
    await m0002.up(db); // re-run updates in place
    const info = await db.command({ rolesInfo: m0002.ROLE, showPrivileges: true });
    const privs = info.roles[0].privileges as { resource: { collection: string }; actions: string[] }[];
    const ledger = privs.find((p) => p.resource.collection === 'ledger')!;
    expect([...ledger.actions].sort()).toEqual(['find', 'insert']);
    for (const p of privs) {
      expect(p.actions).not.toContain('dropCollection');
      expect(p.actions).not.toContain('createIndex');
    }
    expect(privs.find((p) => p.resource.collection === 'tasks')!.actions).toEqual(expect.arrayContaining(['update', 'remove']));
    // every collection created by 0001 (except ledger) is covered
    expect([...m0002.READ_WRITE!].sort()).toEqual(Object.keys(m0001.COLLECTIONS!).filter((c) => c !== 'ledger').sort());

    await m0002.down(db);
    expect((await db.command({ rolesInfo: m0002.ROLE })).roles).toEqual([]);
  });
});
