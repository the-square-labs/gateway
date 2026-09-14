import { container } from '@/container.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
} from '@/modules/object-storage/object-storage.schemas.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { CreateManagedStorageSchema, UpdateManagedStorageSchema } from '@/modules/storage/managed-storage.schemas.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import type { User } from '@/types.js';
import { directResourceIdsForScopes } from './ai.service-helpers.js';
import type { AIToolDefinition } from './ai.types.js';

const id = { type: 'string', description: 'Canonical storage connection UUID' };
const object = { type: 'object', additionalProperties: true };
export const STORAGE_AI_TOOLS: AIToolDefinition[] = [
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
      'List buckets/objects, inspect metadata, create a bucket or prefix, delete objects, or obtain a supported signed download URL.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_buckets', 'list_objects', 'head', 'create_bucket', 'create_prefix', 'delete_objects', 'presign'],
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
    description:
      'Provision, inspect, update, restart or delete MinIO on a Storage node. Private access is the default; external port publication is explicit.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['catalog', 'create', 'get', 'update', 'restart', 'delete'] },
        managedStorageId: { type: 'string' },
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

function requireStorageScope(user: User, scope: string, resourceId?: string) {
  if (!hasScope(user.scopes, resourceId ? `${scope}:${resourceId}` : scope))
    throw new AppError(403, 'FORBIDDEN', `Missing ${scope} permission`);
}

export async function executeStorageTool(user: User, name: string, args: Record<string, unknown>) {
  const service = container.resolve(ObjectStorageService);
  const storageId = typeof args.storageId === 'string' ? args.storageId : '';
  const action = String(args.action ?? '');
  const config =
    args.config && typeof args.config === 'object' && !Array.isArray(args.config)
      ? (args.config as Record<string, unknown>)
      : {};
  if (name === 'list_storage_connections') {
    const allowedIds = directResourceIdsForScopes(user.scopes, 'storage:view');
    if (allowedIds?.length === 0) throw new AppError(403, 'FORBIDDEN', 'Missing storage:view permission');
    return service.list(ObjectStorageListQuerySchema.parse(args), { allowedIds });
  }
  if (name === 'get_storage_connection') {
    requireStorageScope(user, 'storage:view', storageId);
    return service.get(storageId);
  }
  if (name === 'manage_storage_connection') {
    requireStorageScope(
      user,
      action === 'create' ? 'storage:create' : action === 'delete' ? 'storage:delete' : 'storage:edit',
      action === 'create' ? undefined : storageId
    );
    switch (action) {
      case 'create': {
        const input = CreateObjectStorageConnectionSchema.parse(config);
        if (!hasScopeForCreation(user.scopes, 'storage:create', input.folderId))
          throw new AppError(403, 'FORBIDDEN', 'Missing storage:create permission on selected folder');
        return service.create(input, user.id);
      }
      case 'update':
        return service.update(storageId, UpdateObjectStorageConnectionSchema.parse(config), user.id);
      case 'delete':
        return service.delete(storageId, user.id);
      case 'test':
        return service.testSavedConnection(storageId, user.id);
    }
  }
  if (name === 'manage_storage_objects') {
    requireStorageScope(
      user,
      action === 'create_bucket'
        ? 'storage:objects:admin'
        : ['create_prefix', 'delete_objects'].includes(action)
          ? 'storage:objects:write'
          : 'storage:objects:read',
      storageId
    );
    switch (action) {
      case 'list_buckets':
        return service.listBuckets(storageId);
      case 'list_objects':
        return service.listObjects(storageId, ListObjectsQuerySchema.parse(config));
      case 'head': {
        const input = ObjectMetadataQuerySchema.parse(config);
        return service.headObject(storageId, input.bucket, input.key);
      }
      case 'create_bucket':
        return service.createBucket(storageId, CreateBucketSchema.parse(config).bucket, user.id);
      case 'create_prefix': {
        const input = CreatePrefixSchema.parse(config);
        return service.createPrefix(storageId, input.bucket, input.prefix, user.id);
      }
      case 'delete_objects': {
        const input = DeleteObjectsSchema.parse(config);
        return service.deleteObjects(storageId, input.bucket, input.keys, user.id);
      }
      case 'presign':
        return service.presignObject(storageId, PresignObjectSchema.parse({ ...config, operation: 'get' }));
    }
  }
  if (name === 'manage_managed_storage') {
    const managed = container.resolve(ManagedStorageService);
    if (action === 'catalog') {
      const allowed = directResourceIdsForScopes(user.scopes, 'storage:view');
      if (allowed?.length === 0) throw new AppError(403, 'FORBIDDEN', 'Missing storage:view');
      return managed.listCatalog();
    }
    if (action === 'create') {
      const input = CreateManagedStorageSchema.parse(config);
      for (const nodeId of input.memberNodeIds ?? [input.nodeId])
        if (!hasScopeForCreation(user.scopes, 'storage:create', undefined, nodeId))
          throw new AppError(403, 'FORBIDDEN', 'Missing storage:create permission on selected node');
      return managed.create(input, user.id);
    }
    const managedId = String(args.managedStorageId ?? '');
    const canonical = await managed.getCanonicalScopeResourceId(managedId);
    if (!canonical) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Storage connection not found');
    requireStorageScope(
      user,
      action === 'get' ? 'storage:view' : action === 'delete' ? 'storage:delete' : 'storage:edit',
      canonical
    );
    switch (action) {
      case 'get':
        return managed.get(managedId);
      case 'update':
        return managed.update(managedId, UpdateManagedStorageSchema.parse(config), user.id);
      case 'restart':
        return managed.restart(managedId, user.id);
      case 'delete':
        return managed.delete(managedId, user.id);
    }
  }
  throw new AppError(400, 'INVALID_STORAGE_ACTION', 'Unknown storage operation');
}
