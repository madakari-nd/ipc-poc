import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Problem, problemHandler, notFoundHandler } from '../src/errors.js';
import { correlation } from '../src/http.js';

function app(thrower: () => never) {
  const a = express();
  a.use(correlation());
  a.get('/boom', () => thrower());
  a.use(notFoundHandler());
  a.use(problemHandler());
  return a;
}

describe('problem+json errors (RFC 9457, Constitution V)', () => {
  it('renders a Problem with stable code and correlationId', async () => {
    const res = await request(app(() => { throw Problem.forbidden('SCOPE_DENIED', 'Outside your scope'); }))
      .get('/boom')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 403, code: 'SCOPE_DENIED', title: 'Forbidden', detail: 'Outside your scope', correlationId: '0af7651916cd43dd8448eb211c80319c' });
  });

  it('hides internals of unexpected errors behind 500 INTERNAL_ERROR', async () => {
    const res = await request(app(() => { throw new Error('db password=x leaked'); })).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('unknown routes are 404 NOT_FOUND', async () => {
    const res = await request(app(() => { throw new Error(); })).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('a 409 can carry the current resource for the differences view', async () => {
    const res = await request(app(() => { throw Problem.conflict('VERSION_CONFLICT', 'Stale', { current: { v: 3 } }); })).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.current).toEqual({ v: 3 });
  });
});
