import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM for ELEVATE tokens at rest (research T2). `aad` binds the ciphertext to its session. */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes');
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(sealed: string, aad: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error('unsupported token envelope');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

/** Constant-time string comparison (CSRF token, secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
