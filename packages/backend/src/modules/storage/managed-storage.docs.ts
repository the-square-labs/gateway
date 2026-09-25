import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import { DeleteStorageQuerySchema } from '@/modules/object-storage/object-storage.schemas.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  UpdateManagedStorageSchema,
} from './managed-storage.schemas.js';

const accessKeyParams = pathParamSchema('id', 'accessKeyId');

const TAG = 'Managed Storage';

export const listManagedStorageCatalogRoute = appRoute({
  method: 'get',
  path: '/catalog',
  tags: [TAG],
  summary: 'List curated managed object storage versions',
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedStorageRoute = appRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'List managed object storage clusters',
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedStorageRoute = appRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Deploy a managed object storage cluster',
  request: jsonBody(CreateManagedStorageSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const getManagedStorageRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Get managed object storage cluster details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateManagedStorageRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Update managed object storage cluster configuration',
  request: { params: IdParamSchema, ...jsonBody(UpdateManagedStorageSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteManagedStorageRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Delete a managed object storage cluster',
  description:
    'Refused while backup policies or active backup runs use the storage. Finished backup history also blocks deletion (409 STORAGE_BACKUP_HISTORY_EXISTS with historyRecords and backupsWithFiles) unless backupHistory=forget confirms removing it; forgotten backups can no longer be restored or deleted through Gateway, and files stored in this managed storage are deleted with it.',
  request: { params: IdParamSchema, query: DeleteStorageQuerySchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const retryManagedStorageProvisioningRoute = appRoute({
  method: 'post',
  path: '/{id}/retry-provisioning',
  tags: [TAG],
  summary: 'Retry failed managed object storage provisioning',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const restartManagedStorageRoute = appRoute({
  method: 'post',
  path: '/{id}/restart',
  tags: [TAG],
  summary: 'Restart a managed object storage container',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

/** Public certificate material: the Storage CA an S3 client of a TLS cluster must trust. */
export const ManagedStorageCaCertificateSchema = z.object({
  certificatePem: z.string().openapi({ description: 'PEM-encoded Storage CA certificate' }),
  fingerprintSha256: z.string().openapi({
    description: 'SHA-256 fingerprint of the CA certificate (DER), as upper-case hex pairs joined by colons',
    example: 'AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90',
  }),
});

export const getManagedStorageCaCertificateRoute = appRoute({
  method: 'get',
  path: '/{id}/ca-certificate',
  tags: [TAG],
  summary: 'Get the Storage CA certificate that TLS clients of a managed object storage cluster must trust',
  description:
    'Returns the public certificate of the Storage CA that issued the cluster TLS certificate. Requires the same view permission as reading the cluster. Refused with 409 MANAGED_STORAGE_TLS_DISABLED when the cluster does not serve TLS.',
  request: { params: IdParamSchema },
  responses: okJson(dataResponseSchema(ManagedStorageCaCertificateSchema)),
});

export const revealManagedStorageCredentialsRoute = appRoute({
  method: 'get',
  path: '/{id}/reveal-credentials',
  tags: [TAG],
  summary: 'Reveal managed object storage root credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedStorageAccessKeyRoute = appRoute({
  method: 'post',
  path: '/{id}/iam-keys',
  tags: [TAG],
  summary: 'Create a managed object storage IAM access key (secret returned once)',
  request: { params: IdParamSchema, ...jsonBody(CreateManagedStorageAccessKeySchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const listManagedStorageAccessKeysRoute = appRoute({
  method: 'get',
  path: '/{id}/iam-keys',
  tags: [TAG],
  summary: 'List a managed object storage cluster IAM access keys (no secrets)',
  request: { params: IdParamSchema },
  responses: okJson(UnknownListResponseSchema),
});

const bindingParams = IdParamSchema.extend({ bindingId: z.string().uuid() });

export const createManagedStorageBindingRoute = appRoute({
  method: 'post',
  path: '/{id}/bindings',
  tags: [TAG],
  summary: 'Bind a workload to a managed object storage cluster over a private connector',
  request: { params: IdParamSchema, ...jsonBody(CreateManagedStorageBindingSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const listManagedStorageBindingsRoute = appRoute({
  method: 'get',
  path: '/{id}/bindings',
  tags: [TAG],
  summary: 'List managed object storage bindings',
  request: { params: IdParamSchema },
  responses: okJson(UnknownListResponseSchema),
});

export const deleteManagedStorageBindingRoute = appRoute({
  method: 'delete',
  path: '/{id}/bindings/{bindingId}',
  tags: [TAG],
  summary: 'Remove a managed object storage binding',
  request: {
    params: bindingParams,
    body: { required: false, content: { 'application/json': { schema: DeleteManagedStorageBindingSchema } } },
  },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const removeManagedStorageAccessKeyRoute = appRoute({
  method: 'delete',
  path: '/{id}/iam-keys/{accessKeyId}',
  tags: [TAG],
  summary: 'Revoke a managed object storage IAM access key',
  request: { params: accessKeyParams },
  responses: okJson(z.object({ success: z.boolean() })),
});
