/**
 * Builds the inline S3 IAM policy JSON attached to a managed-storage IAM
 * access key (see `ManagedStorageService.createAccessKey`), scoping it to
 * the requested access level and bucket set. Dispatched to the daemon as
 * `DockerStorageIamCommand.policy` (Phase 2b-vii Task 1), which the daemon
 * sets as the svcacct's inline policy on `AddServiceAccount` when non-empty.
 *
 * Three statements, split by resource granularity so bucket scoping is not
 * leaked by the account-level list action:
 *  - account statement: `ListAllMyBuckets` on `arn:aws:s3:::*` — always, even
 *    when scoped. This lists bucket NAMES only (not contents), so a scoped key
 *    can still enumerate which buckets exist without seeing their objects.
 *  - bucket statement: `ListBucket`/`GetBucketLocation` on the SCOPED bucket
 *    ARNs (or `*` when unscoped). `ListBucket` lists a bucket's object keys, so
 *    it must NOT be granted on `*` for a scoped key — otherwise the key could
 *    enumerate every bucket's contents, defeating the scope.
 *  - object statement: `GetObject` (read-only), plus `PutObject`/`DeleteObject`
 *    for read-write, all on the scoped object ARNs (bucket ARN + object suffix).
 *
 * `buckets` empty means "all buckets" (`arn:aws:s3:::*` and the object-level wildcard).
 * Actions and resources are sorted so the same inputs always produce the
 * same JSON string byte-for-byte — required for the daemon to treat two
 * dispatches for the same (access, buckets) as identical, and keeps tests
 * stable.
 */
export type ManagedStorageAccessLevel = 'read-only' | 'read-write';

const ACCOUNT_ACTIONS = ['s3:ListAllMyBuckets'];
const BUCKET_ACTIONS = ['s3:GetBucketLocation', 's3:ListBucket'];
const READ_OBJECT_ACTIONS = ['s3:GetObject'];
const READ_WRITE_OBJECT_ACTIONS = ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'];

const ACCOUNT_LEVEL_BUCKET_ARN = 'arn:aws:s3:::*';

export function buildManagedStoragePolicy(access: ManagedStorageAccessLevel, buckets: string[]): string {
  const scoped = buckets.length > 0;
  const bucketArns = scoped ? buckets.map((bucket) => `arn:aws:s3:::${bucket}`) : [ACCOUNT_LEVEL_BUCKET_ARN];
  const objectArns = scoped ? buckets.map((bucket) => `arn:aws:s3:::${bucket}/*`) : ['arn:aws:s3:::*/*'];

  // `ListBucket` (object-key listing) stays on the scoped bucket ARNs only —
  // NOT `*` — so a scoped key cannot enumerate other buckets' contents.
  const bucketResources = [...bucketArns].sort();
  const objectResources = [...objectArns].sort();
  const objectActions = access === 'read-write' ? READ_WRITE_OBJECT_ACTIONS : READ_OBJECT_ACTIONS;

  const policy = {
    Version: '2012-10-17',
    Statement: [
      // Account-level: list bucket NAMES only (never contents), always on `*`.
      { Effect: 'Allow', Action: [...ACCOUNT_ACTIONS], Resource: [ACCOUNT_LEVEL_BUCKET_ARN] },
      { Effect: 'Allow', Action: [...BUCKET_ACTIONS], Resource: bucketResources },
      { Effect: 'Allow', Action: [...objectActions], Resource: objectResources },
    ],
  };
  return JSON.stringify(policy);
}
