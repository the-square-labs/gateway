import type { DrizzleClient } from '@/db/client.js';
import { objectStorageConnections, objectStorageFolders } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

export class ObjectStorageFolderService extends FolderedResourceService {
  constructor(db: DrizzleClient, auditService: AuditService) {
    super(db, auditService, {
      folderTable: objectStorageFolders,
      resourceTable: objectStorageConnections,
      resourceName: 'object_storage_connection',
      resourcePlural: 'object_storage_connections',
      auditResourceType: 'object_storage_folder',
      eventName: 'storage.folder.changed',
    });
  }
}
