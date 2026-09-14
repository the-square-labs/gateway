import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { S3StorageBackend } from './s3-storage-backend.js';
import { SftpStorageBackend } from './sftp-storage-backend.js';

// Explicit disposable endpoint only. No implicit use of application credentials.
const endpoint = process.env.STORAGE_TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)('S3 backend against disposable MinIO', () => {
  const backend = new S3StorageBackend(
    new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'gatewaytest', secretAccessKey: 'gateway-test-password-2026' },
    })
  );
  const bucket = `gateway-test-${randomUUID()}`;
  afterAll(async () => {
    try {
      await backend.deleteObjects(bucket, ['nested/data.bin', 'empty/']);
      await backend.deleteBucket(bucket);
    } finally {
      backend.destroy();
    }
  });
  it('streams binary data, lists, verifies metadata, presigns and deletes', async () => {
    await backend.probe();
    await backend.createBucket(bucket);
    const body = Buffer.alloc(6 * 1024 * 1024, 0xa5);
    await backend.uploadObject({
      bucket,
      key: 'nested/data.bin',
      body: Readable.from([body.subarray(0, 1024), body.subarray(1024)]),
      contentType: 'application/octet-stream',
    });
    const metadata = await backend.headObject(bucket, 'nested/data.bin');
    expect(metadata.contentLength).toBe(body.length);
    const stream = await backend.getObjectStream(bucket, 'nested/data.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
    const listing = await backend.listObjects({ bucket, prefix: 'nested/' });
    expect(listing.objects.map((object) => object.key)).toContain('nested/data.bin');
    const url = await backend.presignObject({ bucket, key: 'nested/data.bin', operation: 'get', expiresIn: 60 });
    const response = await fetch(url!);
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    await backend.createPrefix(bucket, 'empty/');
    await backend.deleteObjects(bucket, ['nested/data.bin']);
    expect((await backend.listObjects({ bucket, prefix: 'nested/' })).objects).toEqual([]);
  }, 30_000);
});

const sftpPort = Number(process.env.STORAGE_TEST_SFTP_PORT);
const fingerprint = process.env.STORAGE_TEST_SFTP_FINGERPRINT;
describe.skipIf(!sftpPort || !fingerprint)('SFTP backend against disposable OpenSSH', () => {
  const config = {
    provider: 'sftp' as const,
    host: '127.0.0.1',
    port: sftpPort,
    username: 'gatewaytest',
    password: 'gateway-test-password-2026',
    basePath: '/upload',
    implicitTls: false,
    defaultBucket: null,
    hostKeyFingerprint: fingerprint,
  };
  const backend = new SftpStorageBackend(config);
  const bucket = `test-${randomUUID()}`;
  afterAll(async () => {
    try {
      await backend.deleteObjects(bucket, ['data.bin']);
      await backend.deleteBucket(bucket);
    } finally {
      backend.destroy();
    }
  });
  it('rejects an untrusted host before authentication', async () => {
    const wrong = new SftpStorageBackend({
      ...config,
      hostKeyFingerprint: `SHA256:${Buffer.alloc(32).toString('base64').replace(/=+$/, '')}`,
    });
    await expect(wrong.probe()).rejects.toThrow(/verification|fingerprint|handshake/i);
  });
  it('uploads, lists and reads binary data with pinned host identity', async () => {
    await backend.createBucket(bucket);
    const bytes = Buffer.from([0, 1, 255, 128, 10]);
    await backend.uploadObject({ bucket, key: 'data.bin', body: Readable.from([bytes]) });
    expect((await backend.listObjects({ bucket })).objects.map((item) => item.key)).toContain('data.bin');
    const result = await backend.getObjectStream(bucket, 'data.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await backend.presignObject({ bucket, key: 'data.bin', operation: 'get', expiresIn: 60 })).toBeNull();
  }, 30_000);
});

const ftpPort = Number(process.env.STORAGE_TEST_FTP_PORT);
const ftpsPort = Number(process.env.STORAGE_TEST_FTPS_PORT);
const ftpsCaPath = process.env.STORAGE_TEST_FTPS_CA;

import { readFileSync } from 'node:fs';
import { FtpStorageBackend } from './ftp-storage-backend.js';

for (const provider of ['ftp', 'ftps'] as const) {
  const port = provider === 'ftp' ? ftpPort : ftpsPort;
  describe.skipIf(!port || (provider === 'ftps' && !ftpsCaPath))(`${provider.toUpperCase()} disposable server`, () => {
    const config = {
      provider,
      host: '127.0.0.1',
      port,
      username: 'gatewaytest',
      password: 'gateway-test-password-2026',
      basePath: '/',
      implicitTls: false,
      defaultBucket: null,
      ...(provider === 'ftps' && ftpsCaPath ? { caPem: readFileSync(ftpsCaPath, 'utf8') } : {}),
    };
    const backend = new FtpStorageBackend(config);
    const bucket = `test-${randomUUID()}`;
    afterAll(async () => {
      try {
        await backend.deleteBucket(bucket);
      } finally {
        backend.destroy();
      }
    });
    it('creates directories and roundtrips binary files over isolated sessions', async () => {
      await backend.createBucket(bucket);
      const bytes = Buffer.alloc(128 * 1024, 137);
      await backend.uploadObject({ bucket, key: 'nested/data.bin', body: Readable.from([bytes]) });
      const object = await backend.getObjectStream(bucket, 'nested/data.bin');
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect((await backend.listObjects({ bucket, prefix: 'nested/' })).objects.map((item) => item.key)).toContain(
        'nested/data.bin'
      );
      await backend.deleteObjects(bucket, ['nested/data.bin']);
      expect((await backend.listObjects({ bucket, prefix: 'nested/' })).objects).toEqual([]);
    });
    if (provider === 'ftps')
      it('rejects the same server without its private CA', async () => {
        const untrusted = new FtpStorageBackend({ ...config, caPem: undefined });
        await expect(untrusted.probe()).rejects.toThrow(/certificate|self-signed/i);
      });
  });
}
