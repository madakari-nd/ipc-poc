import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoredObject {
  size: number;
  contentType?: string;
}

/** Evidence object storage (MinIO). Injected as an interface so unit tests use a fake. */
export interface ObjectStore {
  presignPut(key: string, o: { contentType: string; contentLength: number; ttlSec: number }): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, o: { ttlSec: number; contentType?: string }): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
  /** SHA-256 (hex) of the stored bytes, computed server-side by streaming the object. */
  sha256(key: string): Promise<string>;
  /** Removes every version and delete marker of the key. Returns how many were removed. */
  deleteAllVersions(key: string): Promise<number>;
  ping(): Promise<boolean>;
}

export interface S3StoreOptions {
  endpoint: string;
  /** Endpoint the browser/device reaches (through Caddy); presigned URLs are signed for it. */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly o: S3StoreOptions) {
    const base = {
      region: o.region,
      forcePathStyle: true,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      maxAttempts: 3,
    };
    this.s3 = new S3Client({ ...base, endpoint: o.endpoint });
    this.signer = o.publicEndpoint ? new S3Client({ ...base, endpoint: o.publicEndpoint }) : this.s3;
  }

  async presignPut(key: string, o: { contentType: string; contentLength: number; ttlSec: number }) {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.o.bucket, Key: key, ContentType: o.contentType, ContentLength: o.contentLength }),
      { expiresIn: o.ttlSec, signableHeaders: new Set(['content-type']) },
    );
    return { url, headers: { 'Content-Type': o.contentType } };
  }

  async presignGet(key: string, o: { ttlSec: number; contentType?: string }) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.o.bucket,
        Key: key,
        ResponseCacheControl: 'no-store',
        ...(o.contentType ? { ResponseContentType: o.contentType } : {}),
      }),
      { expiresIn: o.ttlSec },
    );
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return { size: h.ContentLength ?? 0, contentType: h.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async sha256(key: string): Promise<string> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
    const hash = createHash('sha256');
    for await (const chunk of r.Body as Readable) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  async deleteAllVersions(key: string): Promise<number> {
    let removed = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectVersionsCommand({ Bucket: this.o.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
      );
      const ids = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter((v) => v.Key === key)
        .map((v) => ({ Key: key, VersionId: v.VersionId }));
      if (ids.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.o.bucket, Delete: { Objects: ids, Quiet: true } }));
        removed += ids.length;
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    return removed;
  }

  async ping(): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.o.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
