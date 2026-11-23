import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../src/evidence/object-store.js';

// Minimal S3-compatible endpoint: HEAD/GET object, ListObjectVersions, DeleteObjects, HeadBucket.
const BODY = Buffer.from('photo-bytes');
let versions = ['v1', 'v2'];
let deleted: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    url.pathname = url.pathname.replace(/\/$/, '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/bucket' && req.method === 'HEAD') return res.writeHead(200).end();
      if (url.pathname === '/bucket' && url.searchParams.has('versions')) {
        const xml = `<?xml version="1.0"?><ListVersionsResult><IsTruncated>false</IsTruncated>${versions
          .map((v) => `<Version><Key>p/k</Key><VersionId>${v}</VersionId></Version>`)
          .join('')}<Version><Key>p/k2</Key><VersionId>other</VersionId></Version><DeleteMarker><Key>p/k</Key><VersionId>dm</VersionId></DeleteMarker></ListVersionsResult>`;
        return res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
      }
      if (url.pathname === '/bucket' && url.searchParams.has('delete')) {
        deleted = [...body.matchAll(/<VersionId>([^<]+)<\/VersionId>/g)].map((m) => m[1]!);
        return res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0"?><DeleteResult></DeleteResult>');
      }
      if (url.pathname === '/bucket/p/k') {
        const h = { 'content-type': 'image/jpeg', 'content-length': String(BODY.length) };
        return req.method === 'HEAD' ? res.writeHead(200, h).end() : res.writeHead(200, h).end(BODY);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const store = (endpoint = base, publicEndpoint?: string) =>
  new S3ObjectStore({ endpoint, publicEndpoint, region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'bucket' });

describe('S3ObjectStore (MinIO adapter)', () => {
  it('presigns PUT and GET for at most 300 s, against the public endpoint when set', async () => {
    const s = store(base, 'https://ipc.localhost/evidence-store');
    const put = await s.presignPut('p/k', { contentType: 'image/jpeg', contentLength: 11, ttlSec: 300 });
    expect(put.url).toContain('https://ipc.localhost/evidence-store/bucket/p/k');
    expect(put.url).toContain('X-Amz-Expires=300');
    expect(put.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    const get = await s.presignGet('p/k', { ttlSec: 300, contentType: 'image/jpeg' });
    expect(get).toContain('X-Amz-Expires=300');
    expect(get).toContain('response-cache-control=no-store');
  });

  it('heads, hashes server-side, deletes every version and delete marker of the key only', async () => {
    const s = store();
    expect(await s.head('p/k')).toEqual({ size: BODY.length, contentType: 'image/jpeg' });
    expect(await s.head('p/missing')).toBeNull();
    expect(await s.sha256('p/k')).toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(await s.deleteAllVersions('p/k')).toBe(3);
    expect(deleted.sort()).toEqual(['dm', 'v1', 'v2']);
    versions = [];
    expect(await s.ping()).toBe(true);
    expect(await store('http://127.0.0.1:1').ping()).toBe(false);
  });
});
