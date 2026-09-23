import { container } from '@/container.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertWorkloadBindingTargetAccess } from '@/modules/ai/ai.binding-target-access.js';
import { directResourceIdsForScopes } from '@/modules/ai/ai.service-helpers.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { BucketQuerySchema } from '@/modules/object-storage/object-storage.docs.js';
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
import { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ManagedStorageListQuerySchema,
  UpdateManagedStorageSchema,
} from '@/modules/storage/managed-storage.schemas.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
export const storageToolRuntime = {
  container,
  hasScope,
  hasScopeForCreation,
  AppError,
  hasDockerResourceScope,
  BucketQuerySchema,
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
  ObjectStorageService,
  ObjectStorageUploadService,
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ManagedStorageListQuerySchema,
  UpdateManagedStorageSchema,
  ManagedStorageService,
  ManagedStorageBindingsService,
  directResourceIdsForScopes,
  assertWorkloadBindingTargetAccess,
};
