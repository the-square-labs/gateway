import { describe, expect, it } from 'vitest';
import { buildManagedStoragePolicy } from './managed-storage-iam-policy.js';

describe('buildManagedStoragePolicy', () => {
  it('read-only + all buckets: three statements — account list, bucket ops on *, GetObject on */* — no Put/Delete', () => {
    const policy = JSON.parse(buildManagedStoragePolicy('read-only', []));

    expect(policy).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListAllMyBuckets'], Resource: ['arn:aws:s3:::*'] },
        { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket'], Resource: ['arn:aws:s3:::*'] },
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::*/*'] },
      ],
    });
  });

  it('read-write + all buckets: adds PutObject/DeleteObject to the object statement', () => {
    const policy = JSON.parse(buildManagedStoragePolicy('read-write', []));

    expect(policy.Statement[2]).toEqual({
      Effect: 'Allow',
      Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::*/*'],
    });
  });

  it('specific buckets: ListBucket is scoped to those buckets ONLY (never *), while ListAllMyBuckets stays account-level', () => {
    const policy = JSON.parse(buildManagedStoragePolicy('read-only', ['b1', 'b2']));

    // Account-level name listing stays on * (bucket names only, not contents).
    expect(policy.Statement[0]).toEqual({
      Effect: 'Allow',
      Action: ['s3:ListAllMyBuckets'],
      Resource: ['arn:aws:s3:::*'],
    });
    // Object-key listing (ListBucket) is scoped — MUST NOT include the `*` ARN,
    // or the key could enumerate every bucket's contents.
    expect(policy.Statement[1]).toEqual({
      Effect: 'Allow',
      Action: ['s3:GetBucketLocation', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::b1', 'arn:aws:s3:::b2'],
    });
    expect(policy.Statement[1].Resource).not.toContain('arn:aws:s3:::*');
    expect(policy.Statement[2]).toEqual({
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::b1/*', 'arn:aws:s3:::b2/*'],
    });
  });

  it('specific buckets + read-write: object statement gains Put/Delete, scoped to the same buckets', () => {
    const policy = JSON.parse(buildManagedStoragePolicy('read-write', ['b1']));

    expect(policy.Statement[2]).toEqual({
      Effect: 'Allow',
      Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::b1/*'],
    });
  });

  it('produces byte-identical output regardless of input bucket order (deterministic)', () => {
    const a = buildManagedStoragePolicy('read-write', ['zeta', 'alpha']);
    const b = buildManagedStoragePolicy('read-write', ['alpha', 'zeta']);

    expect(a).toBe(b);
  });
});
