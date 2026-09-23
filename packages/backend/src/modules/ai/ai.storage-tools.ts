import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { storageToolRuntime } from '@/modules/object-storage/storage-tool-runtime.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';

const id = { type: 'string', description: 'Canonical storage connection UUID' };
const object = { type: 'object', additionalProperties: true };
export const STORAGE_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'upload_storage_object',
    description:
      'Upload an object through authenticated MCP using begin/chunk/status/finalize/abort, like Pages artifact uploads. Send exact size and SHA-256, then ordered base64 chunks of at most 1 MiB decoded. Finalization streams the verified private spool into storage. Sessions expire after one hour and do not survive Gateway restart. Never pass credentials. An existing key is overwritten on successful finalization.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['begin', 'chunk', 'status', 'finalize', 'abort'] },
        storageId: id,
        uploadId: { type: 'string', description: 'Upload UUID returned by begin, required for other operations.' },
        bucket: { type: 'string' },
        key: { type: 'string' },
        declaredSizeBytes: { type: 'number', description: 'Exact total bytes for begin.' },
        sha256: { type: 'string', description: 'Lowercase complete object SHA-256 for begin.' },
        contentType: { type: 'string' },
        offset: { type: 'number', description: 'Expected current byte offset for chunk.' },
        contentBase64: { type: 'string', maxLength: 1_398_104 },
      },
      required: ['operation', 'storageId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:objects:write',
    mcpOnly: true,
    historyRetention: { mode: 'never_full' },
    invalidateStores: [],
  },
  {
    name: 'list_storage_connections',
    description: 'List authorized external and managed S3, FTP, FTPS and SFTP connections.',
    parameters: { type: 'object', properties: { search: { type: 'string' } } },
    destructive: false,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: [],
  },
  {
    name: 'get_storage_connection',
    description: 'Read safe storage connection details without credentials.',
    parameters: { type: 'object', properties: { storageId: id }, required: ['storageId'] },
    destructive: false,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: [],
  },
  {
    name: 'manage_storage_connection',
    description:
      'Create, update, test or delete an external storage connection. Config is validated by the storage API.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'test', 'delete'] },
        storageId: id,
        config: object,
      },
      required: ['action'],
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:edit',
    invalidateStores: ['storage:list'],
  },
  {
    name: 'manage_storage_objects',
    description:
      'List buckets/objects, inspect metadata, create or delete a bucket, create a prefix, delete objects, or obtain a supported signed download URL. delete_bucket takes config.bucket and needs storage:objects:admin.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_buckets',
            'list_objects',
            'head',
            'create_bucket',
            'delete_bucket',
            'create_prefix',
            'delete_objects',
            'presign',
          ],
        },
        storageId: id,
        config: object,
      },
      required: ['action', 'storageId'],
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:objects:read',
    invalidateStores: [],
  },
  {
    name: 'manage_managed_storage',
    historyRetention: { mode: 'never_full' },
    description:
      'Provision and manage Gateway-managed MinIO, private workload links, and scoped IAM keys. Read the catalog before create, poll get until ready, then create a bucket-scoped link. create_access_key returns its generated secret once; no read action reveals root or key secrets.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'catalog',
            'list',
            'get',
            'create',
            'update',
            'retry',
            'restart',
            'delete',
            'list_bindings',
            'create_binding',
            'delete_binding',
            'list_access_keys',
            'create_access_key',
            'remove_access_key',
          ],
        },
        managedStorageId: { type: 'string' },
        bindingId: { type: 'string' },
        accessKeyId: { type: 'string' },
        config: object,
      },
      required: ['action'],
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: ['storage:list'],
  },
];
export const STORAGE_TOOL_NAMES = new Set(STORAGE_AI_TOOLS.map(({ name }) => name));

export async function executeStorageTool(user: User, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeStorageTool(user, name, args, storageToolRuntime);
}
