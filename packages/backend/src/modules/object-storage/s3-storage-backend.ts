import type { S3Client } from '@aws-sdk/client-s3';
import {
  createBucket,
  createPrefix,
  deleteBucket,
  deleteObjects,
  getObjectStream,
  headObject,
  listBuckets,
  listObjects,
  presignObject,
  uploadObject,
} from './s3-object-operations.js';
import type {
  ListObjectsParams,
  ObjectStreamResult,
  PresignParams,
  StorageBackend,
  UploadObjectParams,
} from './storage-backend.js';

/**
 * Adapts the existing S3 command helpers to the protocol-neutral
 * StorageBackend interface. Behavior is unchanged — this only moves the
 * S3Client from the service's call sites behind the interface.
 */
export class S3StorageBackend implements StorageBackend {
  /** Exposed so callers that must inspect S3-specific client config can reach it. */
  constructor(public readonly client: S3Client) {}

  listBuckets() {
    return listBuckets(this.client);
  }

  createBucket(bucket: string) {
    return createBucket(this.client, bucket);
  }

  deleteBucket(bucket: string) {
    return deleteBucket(this.client, bucket);
  }

  listObjects(params: ListObjectsParams) {
    return listObjects(this.client, params);
  }

  headObject(bucket: string, key: string) {
    return headObject(this.client, bucket, key);
  }

  async presignObject(params: PresignParams): Promise<string | null> {
    return presignObject(this.client, params);
  }

  uploadObject(params: UploadObjectParams) {
    return uploadObject(this.client, params);
  }

  getObjectStream(bucket: string, key: string): Promise<ObjectStreamResult> {
    return getObjectStream(this.client, bucket, key);
  }

  createPrefix(bucket: string, prefix: string) {
    return createPrefix(this.client, bucket, prefix);
  }

  deleteObjects(bucket: string, keys: string[]) {
    return deleteObjects(this.client, bucket, keys);
  }

  async probe(): Promise<void> {
    await listBuckets(this.client);
  }

  destroy(): void {
    this.client.destroy();
  }
}
