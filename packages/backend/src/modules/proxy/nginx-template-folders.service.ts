import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nginxTemplateFolders, nginxTemplates } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  MoveResourcesToFolderInput,
  ReorderResourcesInput,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

/** Custom nginx templates only: built-ins stay in the read-only built-in group. */
export class NginxTemplateFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: nginxTemplateFolders,
      resourceTable: nginxTemplates,
      resourceName: 'nginx_template',
      resourcePlural: 'nginx_templates',
      auditResourceType: 'nginx_template_folder',
      eventName: 'nginx.template.folder.changed',
    });
  }

  override async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    await this.assertCustom(input.ids);
    return super.moveResourcesToFolder(input, userId);
  }

  override async reorderResources(input: ReorderResourcesInput) {
    await this.assertCustom(input.items.map((item) => item.id));
    return super.reorderResources(input);
  }

  private async assertCustom(ids: readonly string[]) {
    const rows = await this.database
      .select({ id: nginxTemplates.id, isBuiltin: nginxTemplates.isBuiltin })
      .from(nginxTemplates)
      .where(inArray(nginxTemplates.id, [...ids]));
    if (rows.length !== new Set(ids).size) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    if (rows.some((row) => row.isBuiltin)) {
      throw new AppError(400, 'BUILTIN_TEMPLATE_FOLDER_LOCKED', 'Built-in templates cannot be placed in folders');
    }
  }
}
