import type { DrizzleClient } from '@/db/client.js';
import { pageProjectFolders, pageProjects } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';
import { PAGE_EVENT_CHANNELS } from './page-events.js';

export class PageProjectFolderService extends FolderedResourceService {
  constructor(db: DrizzleClient, auditService: AuditService) {
    super(db, auditService, {
      folderTable: pageProjectFolders,
      resourceTable: pageProjects,
      resourceName: 'page_project',
      resourcePlural: 'page_projects',
      auditResourceType: 'page_project_folder',
      eventName: PAGE_EVENT_CHANNELS.folder,
    });
  }
}
