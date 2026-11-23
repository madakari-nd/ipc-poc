import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { problemHandler } from '@ipc/platform';
import { assertVersion, etag, ifMatchMiddleware, parseIfMatch } from '../src/middleware/version.js';

describe('If-Match version handling (T042, FR-016)', () => {
  it('parses a strong ETag', () => {
    expect(parseIfMatch('"7"')).toBe(7);
    expect(parseIfMatch(' "0" ')).toBe(0);
    expect(etag(8)).toBe('"8"');
  });

  it('missing header → 400 IF_MATCH_REQUIRED; malformed → 400 VALIDATION_FAILED', () => {
    expect(() => parseIfMatch(undefined)).toThrow(expect.objectContaining({ status: 400, code: 'IF_MATCH_REQUIRED' }));
    expect(() => parseIfMatch('')).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    expect(() => parseIfMatch('W/"7"')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => parseIfMatch('*')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('stale version → 409 VERSION_CONFLICT carrying currentVersion and the current resource', () => {
    const current = { id: 'x', v: 4, title: 'now' };
    expect(() => assertVersion(3, { v: 4, body: current })).toThrow(
      expect.objectContaining({ status: 409, code: 'VERSION_CONFLICT', extensions: { currentVersion: 4, current } }),
    );
    expect(() => assertVersion(4, { v: 4, body: current })).not.toThrow();
    expect(() => assertVersion(undefined, { v: 4, body: current })).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
  });

  it('middleware applies only to operations that declare If-Match', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.operation = { ifMatch: req.path === '/versioned' } as never;
      next();
    });
    app.use(ifMatchMiddleware());
    app.post('/versioned', (req, res) => {
      assertVersion(req.ifMatch, { v: 2, body: { v: 2 } });
      res.json({ ok: true });
    });
    app.post('/plain', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(problemHandler());
    expect((await request(app).post('/plain')).status).toBe(200);
    const missing = await request(app).post('/versioned').set('Idempotency-Key', randomUUID());
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IF_MATCH_REQUIRED');
    const stale = await request(app).post('/versioned').set('If-Match', '"1"');
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2, current: { v: 2 } });
    expect((await request(app).post('/versioned').set('If-Match', '"2"')).status).toBe(200);
  });
});
