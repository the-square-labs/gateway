import { z } from 'zod';

const managedStorageNameSchema = z.string().trim().min(1).max(255);
// DTO validation is shared; the installed storage provider checks its private
// version catalog before creating any workload or database record.
const managedStorageVersionSchema = z.string().trim().min(1).max(128);
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).optional();

export const ManagedStorageListQuerySchema = z.object({
  nodeId: z.string().uuid().optional(),
});

/**
 * Create-time schema for a managed (MinIO) object storage cluster. Mirrors
 * `CreateManagedDatabaseSchema`'s shape (see `modules/databases/databases.schemas.ts`),
 * trimmed to what this phase's single-node MinIO deployment needs: no
 * `type` discriminant (storage has exactly one provisionable type), a
 * REQUIRED `publishedPort` (MinIO's S3 API host port is fixed at create
 * time — there is no "publish later" toggle like the database schemas'
 * `publishTcp`), and optional root credentials that default to strong
 * generated ones when omitted.
 */
export const CreateManagedStorageSchema = z
  .object({
    name: managedStorageNameSchema,
    version: managedStorageVersionSchema,
    nodeId: z.string().uuid(),
    storageSizeGb: z.number().finite().min(1).max(16_384),
    cpuCores: z.number().min(0.1).max(128),
    memoryMb: z.number().int().min(256).max(524_288),
    swapMb: z.number().int().min(0).max(524_288).default(0),
    publishS3: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).default(9000),
    tags: tagsSchema,
    accessKey: z.string().trim().min(3).max(128).optional(),
    secretKey: z.string().min(8).max(256).optional(),
    // When present, this is a distributed cluster and every entry (including
    // `nodeId`'s counterpart, if reused) is a member node. Omitted keeps the
    // existing single-node shape: the sole member is `nodeId`. EC minimum is
    // 4 members (see `ManagedStorageService.create`'s topology check, which
    // also covers the `nodeId`-only single-node case).
    memberNodeIds: z.array(z.string().uuid()).optional(),
    // Drives contributed per member node; defaults to 1 in the service when
    // omitted (kept optional here, not `.default()`, so the single-node
    // shape's absence of this field round-trips as `undefined` rather than
    // silently gaining a new required-looking key).
    // Capped at 1 this phase: the pool-arg renderer emits exactly one `/data`
    // per member — multi-drive-per-node (`/data{1...D}`) is a later phase, so
    // we refuse to persist an erasureConfig topology the renderer won't honor.
    drivesPerNode: z.number().int().min(1).max(1).optional(),
    // Opt-in TLS cert issuance from the internal Storage CA at create time
    // (see `ManagedStorageService.create`). Defaults to false in the
    // service when omitted — unchanged behavior for existing callers. This
    // phase only issues + persists the cert; nothing serves it over HTTPS
    // yet (Phase 2b-ii-B).
    tlsEnabled: z.boolean().optional(),
    // Opt-in gateway-local relay: the S3 client reaches the cluster over a
    // 127.0.0.1 loopback tunnel (`ManagedStorageTunnelProxy`) instead of a
    // publicly reachable S3 port (see `ManagedStorageService.create`).
    // Defaults to false in the service when omitted — unchanged (direct
    // `host:publishedPort`) behavior for existing callers. Relay implies TLS:
    // the service forces `tlsEnabled` on for a relay create regardless of
    // this field, since the loopback leg is only ever served over HTTPS.
    relayEnabled: z.boolean().optional(),
    // Opt-in exposure of MinIO's built-in SFTP server, authenticated by the
    // IAM service-account keys (see `CreateManagedStorageAccessKeySchema`) —
    // no separate SFTP-specific credential. Defaults to false in the service
    // when omitted — unchanged behavior for existing callers. `sftpPort` is
    // REQUIRED when `sftpEnabled` (enforced below via `superRefine`, mirroring
    // the `memberNodeIds` topology check), since MinIO needs a host port to
    // bind the SFTP listener to. Deliberately no cross-cluster port-conflict
    // check — operator-supplied, same model as `publishedPort` above.
    sftpEnabled: z.boolean().optional(),
    sftpPort: z.number().int().min(1).max(65535).optional(),
    // Opt-in exposure of MinIO's built-in FTP server, authenticated by the
    // same IAM service-account keys as SFTP — no separate FTP-specific
    // credential. Defaults to false in the service when omitted — unchanged
    // behavior for existing callers. Both `ftpPort` (the host control port)
    // and `ftpPassivePortStart` (the first of the passive-mode data range)
    // are REQUIRED when `ftpEnabled` (enforced below via `superRefine`),
    // since MinIO needs a host port for the control listener and Docker
    // needs the passive range published host==container. FTPS is automatic
    // whenever the cluster's own `tlsEnabled` is on (MinIO reuses the S3
    // API's cert) — no separate FTPS toggle. `ftpPassivePortStart`'s static
    // max moved to 65_535 (the true port ceiling) — the dynamic bound of
    // `start + (ftpPassivePortCount ?? 10) - 1 <= 65535` is enforced in
    // `superRefine` below, since it depends on the optional
    // `ftpPassivePortCount`. Deliberately no cross-cluster port-conflict
    // check — operator-supplied, same model as `publishedPort`/`sftpPort`
    // above.
    ftpEnabled: z.boolean().optional(),
    ftpPort: z.number().int().min(1).max(65535).optional(),
    ftpPassivePortStart: z.number().int().min(1).max(65535).optional(),
    // Size of the passive-mode data range (Phase 2b-viii Task 1). Optional —
    // omitted (the default) keeps the historical fixed 10-port range
    // (`ftpPassivePortCount ?? 10`, enforced everywhere downstream:
    // `StorageWorkloadDispatch.renderCommandPayload`, `collectClusterHostPorts`).
    // Capped at 64 — generous headroom over the historical default without
    // opening up an unbounded host-port land grab; the lower bound of 1
    // matches `ftpPort`'s own single-port semantics.
    ftpPassivePortCount: z.number().int().min(1).max(64).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.memberNodeIds !== undefined) {
      if (value.memberNodeIds.length < 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['memberNodeIds'],
          message: 'A distributed managed storage cluster requires at least 4 member nodes',
        });
      }
      if (new Set(value.memberNodeIds).size !== value.memberNodeIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['memberNodeIds'],
          message: 'memberNodeIds must not contain duplicate node ids',
        });
      }
    }
    if (value.sftpEnabled && value.sftpPort === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sftpPort'],
        message: 'sftpPort is required when sftpEnabled is true',
      });
    }
    if (value.ftpEnabled && value.ftpPort === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ftpPort'],
        message: 'ftpPort is required when ftpEnabled is true',
      });
    }
    if (value.ftpEnabled && value.ftpPassivePortStart === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ftpPassivePortStart'],
        message: 'ftpPassivePortStart is required when ftpEnabled is true',
      });
    }
    // The dynamic counterpart to `ftpPassivePortStart`'s static `max(65535)`
    // above: the LAST port in the passive range (`start + count - 1`, where
    // `count` defaults to 10 exactly like every downstream reader) must
    // still fit under the true port ceiling.
    if (value.ftpEnabled && value.ftpPassivePortStart !== undefined) {
      const effectiveCount = value.ftpPassivePortCount ?? 10;
      if (value.ftpPassivePortStart + effectiveCount - 1 > 65535) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ftpPassivePortStart'],
          message: 'ftpPassivePortStart + ftpPassivePortCount - 1 must not exceed 65535',
        });
      }
    }
  });

export const UpdateManagedStorageSchema = z
  .object({
    name: managedStorageNameSchema.optional(),
    tags: tagsSchema,
    storageSizeGb: z.number().finite().min(1).max(16_384).optional(),
    cpuCores: z.number().min(0.1).max(128).optional(),
    memoryMb: z.number().int().min(256).max(524_288).optional(),
    swapMb: z.number().int().min(0).max(524_288).optional(),
    publishS3: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided' });

/**
 * Create-time schema for a managed storage IAM (MinIO) service-account
 * access key. `name` is a display label only — MinIO itself generates the
 * access key id and secret unless a later phase adds explicit id/secret
 * input (deliberately not exposed yet: letting a caller pick their own
 * secret defeats the "shown once, strongly random" guarantee the reveal-once
 * UX relies on).
 *
 * `access`/`buckets` (Phase 2b-vii Task 2) scope the inline IAM policy
 * `ManagedStorageService.createAccessKey` builds via
 * `buildManagedStoragePolicy` and dispatches to the daemon. `access`
 * defaults to `'read-write'` — unchanged behavior for existing callers that
 * omit it (MinIO's own default policy grants full read-write, so a key that
 * pre-dates this field feels equivalent). `buckets` omitted/empty means "all
 * buckets", also matching prior behavior. Bucket names are validated to the
 * S3 naming grammar HERE (this is the enforcement boundary): each name is
 * interpolated into an IAM policy ARN (`arn:aws:s3:::<name>`), and IAM treats
 * `*`/`?` as wildcards — so a name like `*` or `foo*` would widen a "scoped"
 * key back to every bucket. The regex (lowercase alphanumerics, dots, hyphens;
 * must start/end alphanumeric; 3-63 chars) excludes `*`, `?`, `/`, whitespace,
 * quotes, commas and uppercase, so no injected name can broaden the scope.
 */
export const managedStorageBucketNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid S3 bucket name');

export const CreateManagedStorageAccessKeySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  access: z.enum(['read-only', 'read-write']).default('read-write'),
  buckets: z.array(managedStorageBucketNameSchema).max(64).optional(),
  // Optional ISO-8601 expiration. Must be a real datetime strictly in the
  // future; MinIO's own validateSAExpiration enforces its min/max bounds and
  // any such rejection is surfaced verbatim. Omitted ⇒ the key never expires.
  expiresAt: z
    .string()
    .datetime({ message: 'expiresAt must be an ISO-8601 datetime' })
    .refine((value) => new Date(value).getTime() > Date.now(), { message: 'expiresAt must be in the future' })
    .optional(),
});

export type ManagedStorageListQuery = z.infer<typeof ManagedStorageListQuerySchema>;
export type CreateManagedStorageInput = z.infer<typeof CreateManagedStorageSchema>;
export type UpdateManagedStorageInput = z.infer<typeof UpdateManagedStorageSchema>;
// `z.input` (not `z.infer`/`z.output`): `access`'s `.default('read-write')`
// makes the *parsed* output always resolved/required, but callers of
// `ManagedStorageService.createAccessKey` (this type) should still see it as
// optional — the service itself resolves the default via `input.access ??
// 'read-write'`, mirroring how `input.buckets` is already handled.
export type CreateManagedStorageAccessKeyInput = z.input<typeof CreateManagedStorageAccessKeySchema>;

/**
 * Environment variable names a binding writes into its target workload. Every
 * field is optional: an application that only needs an endpoint and keys
 * should not be forced to accept a bucket or region variable it ignores.
 */
const storageBindingEnvironmentSchema = z
  .object({
    endpoint: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    accessKeyId: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    secretAccessKey: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    bucket: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    region: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
  })
  .refine((value) => Object.values(value).some(Boolean), {
    message: 'At least one environment variable name is required',
  })
  .refine(
    (value) => {
      const names = Object.values(value).filter(Boolean);
      return new Set(names).size === names.length;
    },
    {
      message: 'Use distinct environment variable names',
    }
  );

export const CreateManagedStorageBindingSchema = z.object({
  targetNodeId: z.string().uuid(),
  targetType: z.enum(['container', 'deployment']),
  targetResourceId: z.string().trim().min(1).max(255),
  environment: storageBindingEnvironmentSchema,
  targetEnvironment: z.record(z.string(), z.string()).optional(),
  // Scoping a binding to no bucket would hand the workload the whole cluster,
  // which defeats the point of a per-binding identity.
  buckets: z.array(managedStorageBucketNameSchema).min(1).max(32),
});

export type CreateManagedStorageBindingInput = z.infer<typeof CreateManagedStorageBindingSchema>;

export const DeleteManagedStorageBindingSchema = z.object({
  targetEnvironment: z.record(z.string(), z.string()).optional(),
});
