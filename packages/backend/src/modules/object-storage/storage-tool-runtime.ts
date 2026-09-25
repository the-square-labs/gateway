import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
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
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ImportManagedStorageAccessKeysSchema,
  ManagedStorageListQuerySchema,
  MoveManagedStorageBindingSchema,
  RehomeManagedStorageBackupHistorySchema,
  UpdateManagedStorageSchema,
} from '@/modules/storage/managed-storage.schemas.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import {
  StartStorageCopyJobSchema,
  StorageCopyJobIdSchema,
  StorageCopyJobListQuerySchema,
} from '@/modules/storage/storage-copy.schemas.js';
import { StorageCopyService } from '@/modules/storage/storage-copy.service.js';
export const storageToolRuntime = {
  container,
  hasScope,
  hasScopeBase,
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
  ObjectStorageFolderService,
  ObjectStorageMonitoringService,
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
  MoveManagedStorageBindingSchema,
  ImportManagedStorageAccessKeysSchema,
  RehomeManagedStorageBackupHistorySchema,
  StorageCopyService,
  StartStorageCopyJobSchema,
  StorageCopyJobIdSchema,
  StorageCopyJobListQuerySchema,
};
