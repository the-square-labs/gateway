import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface S3BucketInfo {
  name: string;
  creationDate: string | null;
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface S3ObjectListing {
  prefixes: string[];
  objects: S3ObjectInfo[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

export interface S3ObjectMetadata {
  contentType: string | null;
  contentLength: number;
  lastModified: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export async function listBuckets(client: S3Client): Promise<S3BucketInfo[]> {
  const res = await client.send(new ListBucketsCommand({}));
  return (res.Buckets ?? []).map((b) => ({
    name: b.Name ?? '',
    creationDate: b.CreationDate?.toISOString() ?? null,
  }));
}

export async function createBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

export async function deleteBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export async function listObjects(
  client: S3Client,
  params: { bucket: string; prefix?: string; delimiter?: string; continuationToken?: string; maxKeys?: number }
): Promise<S3ObjectListing> {
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: params.bucket,
      Prefix: params.prefix || undefined,
      Delimiter: params.delimiter || undefined,
      ContinuationToken: params.continuationToken || undefined,
      MaxKeys: params.maxKeys,
    })
  );
  const prefixes = (res.CommonPrefixes ?? []).map((p) => p.Prefix ?? '').filter(Boolean);
  const objects: S3ObjectInfo[] = (res.Contents ?? [])
    // Drop the prefix placeholder object itself (a zero-byte key equal to the prefix).
    .filter((o) => o.Key && o.Key !== params.prefix)
    .map((o) => ({
      key: o.Key ?? '',
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString() ?? null,
      etag: o.ETag ?? null,
      storageClass: o.StorageClass ?? null,
    }));
  return {
    prefixes,
    objects,
    nextContinuationToken: res.NextContinuationToken ?? null,
    isTruncated: !!res.IsTruncated,
  };
}

export async function headObject(client: S3Client, bucket: string, key: string): Promise<S3ObjectMetadata> {
  const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return {
    contentType: res.ContentType ?? null,
    contentLength: res.ContentLength ?? 0,
    lastModified: res.LastModified?.toISOString() ?? null,
    etag: res.ETag ?? null,
    metadata: res.Metadata ?? {},
  };
}

export async function presignObject(
  client: S3Client,
  params: { bucket: string; key: string; operation: 'get' | 'put'; contentType?: string; expiresIn: number }
): Promise<string> {
  const command =
    params.operation === 'put'
      ? new PutObjectCommand({ Bucket: params.bucket, Key: params.key, ContentType: params.contentType })
      : new GetObjectCommand({ Bucket: params.bucket, Key: params.key });
  return getSignedUrl(client, command, { expiresIn: params.expiresIn });
}

export async function uploadObject(
  client: S3Client,
  params: { bucket: string; key: string; body: Buffer | Uint8Array | Readable; contentType?: string }
): Promise<void> {
  // Upload handles streaming bodies of unknown length by buffering into 5 MiB parts
  // and switching to multipart automatically, so large objects never sit fully in memory.
  const upload = new Upload({
    client,
    params: {
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    },
  });
  await upload.done();
}

export async function getObjectStream(
  client: S3Client,
  bucket: string,
  key: string
): Promise<{ body: Readable; contentType: string | null; contentLength: number | null }> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    body: res.Body as Readable,
    contentType: res.ContentType ?? null,
    contentLength: res.ContentLength ?? null,
  };
}

export async function createPrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  const key = prefix.endsWith('/') ? prefix : `${prefix}/`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(0) }));
}

export async function deleteObjects(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    })
  );
}
