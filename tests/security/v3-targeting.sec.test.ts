/**
 * T060 / V3 (US9 AS3, FR-028): a request whose body (or query) claims another organisation,
 * facility, role or targeting profile. Edge: the claims are stripped and the server-derived scope is
 * used, so nothing of Hospital A comes back to a Hospital B user. Direct ELEVATE: a hosp_b user
 * posting Hospital A's targeting profile to `solutions/targetedSolutions` gets A's solutions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, directSkipReason, LAB, token, url } from './helpers/direct.js';
import { edgeSide, record } from './helpers/record.js';
import { intentBody, openTarget } from './helpers/target.js';

const ID = 'V3';
const TITLE = 'V3: a targeting body that claims another org';
const t = await openTarget();
const directSkip = await directSkipReason();
afterAll(() => t.close());

describe.skipIf(!!t.skip)(`${TITLE} — through the Edge (${t.name})`, () => {
  it('claimed org, facility, role and targeting are ignored; 0 cross-org results', async (ctx) => {
    await edgeSide(ID, TITLE, t, () => ctx.skip(), async () => {
      const { facilityA, facilityB, wardB, assessB, wardA } = t.ids;
      const claims = {
        orgId: 'default_code',
        organization_ids: ['1'],
        tenant_code: 'default',
        facilityId: facilityA,
        districtCode: 'D1',
        role: 'STATE_ADMIN',
        scope: { level: 'state' },
        targeting: { state: LAB.targeting.state, district: LAB.targeting.district },
        userRoleAndProfileInformation: { ...LAB.targeting, role: 'STATE_ADMIN' },
      };
      const b = await t.login('hospB');

      // 1) A write that claims Hospital A + state role lands in Hospital B's own scope.
      const w = await b.write('post', '/ipc/v1/evidence/intents', { ...intentBody({ wardId: wardB, link: { type: 'question', id: `${assessB}:Q1` } }), ...claims });
      expect(w.status).toBe(201);
      expect(w.body.evidence).toMatchObject({ facilityId: facilityB, wardId: wardB });
      expect(JSON.stringify(w.body)).not.toContain(facilityA);

      // 2) A read that claims Hospital A / state role in the query: scope stays Hospital B.
      const me = await b.get(`/ipc/v1/me?facilityId=${facilityA}&role=STATE_ADMIN&orgId=default_code`);
      expect(me.status).toBe(200);
      expect(me.body.activeRole).toBe('IPC_OFFICER');
      const crossOrg = (me.body.assignments as { scope: Record<string, unknown> }[]).filter((a) => JSON.stringify(a.scope).includes(facilityA) || a.scope.level === 'state');
      expect(crossOrg).toHaveLength(0);

      // 3) The claim cannot widen a write to Hospital A's ward either.
      const into = await b.write('post', '/ipc/v1/evidence/intents', { ...intentBody({ wardId: wardA, link: { type: 'question', id: `${t.ids.assessA}:Q1` } }), ...claims });
      expect(into.status).toBe(403);
      expect(into.body.code).toBe('SCOPE_DENIED');

      // 4) Workflow only ever saw the server-derived actor.
      if (t.forwardedActors) {
        expect(t.forwardedActors.length).toBeGreaterThan(0);
        expect(new Set(t.forwardedActors.map((a) => `${a.userId}/${a.role}`))).toEqual(new Set(['officerB/IPC_OFFICER']));
      }
      return { result: `claims ignored (201 in own scope, 403 SCOPE_DENIED into A); 0 cross-org results`, refused: true, source: 'live' };
    });
  });
});

if (t.skip) record(ID, TITLE, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });

describe.skipIf(!!directSkip)(`${TITLE} — directly against ELEVATE`, () => {
  it('records what a hosp_b user gets when it posts Hospital A\'s targeting profile', async () => {
    const r = await call(
      url('ELEVATE_PROJECT_URL', 'http://localhost:6001'),
      'POST',
      '/project/v1/solutions/targetedSolutions?type=improvementProject&page=1&limit=50',
      { token: await token('hospB'), body: LAB.targeting },
    );
    const res = (r.body?.result ?? {}) as { count?: number; data?: { name?: string }[] };
    const n = res.count ?? res.data?.length ?? 0;
    record(ID, TITLE, t.name, 'direct', {
      result: `${r.status}, ${n} solutions of org default_code returned to a hosp_b user`,
      refused: n === 0,
      source: 'live',
      ...(n !== 4 ? { note: `research §4 recorded 4 solutions; this run saw ${n}` } : {}),
    });
    expect(r.status).toBeGreaterThan(0);
  });
});

if (directSkip) record(ID, TITLE, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note: directSkip });
