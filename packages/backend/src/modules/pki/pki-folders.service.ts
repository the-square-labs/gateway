import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  certificateAuthorities,
  certificates,
  certificateTemplates,
  pkiCaFolders,
  pkiCertificateFolders,
  pkiTemplateFolders,
} from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  MoveResourceFolderInput,
  MoveResourcesToFolderInput,
  ReorderResourcesInput,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { FolderedResourceService, type FolderMoveAccess } from '@/modules/resource-folders/resource-folder.service.js';
import { rootCaIds } from './ca-folder-placement.js';

type FolderTreeOptions = Parameters<FolderedResourceService['getFolderTree']>[0];

/**
 * CA folders hold whole hierarchies: the folder is stored on a root CA, and its intermediates are
 * listed with it. Only root CAs move between folders; `sort_order` orders roots within a folder and
 * intermediates under their parent.
 */
export class CAFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: pkiCaFolders,
      resourceTable: certificateAuthorities,
      resourceName: 'ca',
      resourcePlural: 'cas',
      auditResourceType: 'pki_ca_folder',
      eventName: 'ca.folder.changed',
    });
  }

  override async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    const rows = await this.rows(input.ids);
    if (rows.some((row) => row.isSystem)) {
      throw new AppError(409, 'PKI_SYSTEM_CA_FOLDER_LOCKED', 'System CA placement cannot be changed');
    }
    if (rows.some((row) => row.parentId !== null)) {
      throw new AppError(
        400,
        'PKI_CA_NOT_ROOT',
        'Only root CAs move between folders; an intermediate CA follows its root'
      );
    }
    return super.moveResourcesToFolder(input, userId);
  }

  override async reorderResources(input: ReorderResourcesInput) {
    const rows = await this.rows(input.items.map((item) => item.id));
    if (rows.some((row) => row.isSystem)) {
      throw new AppError(409, 'PKI_SYSTEM_CA_FOLDER_LOCKED', 'System CA placement cannot be changed');
    }
    return super.reorderResources(input);
  }

  /** A CA granted to a scoped caller shows the folder of its root, where the list places it. */
  override async getFolderTree(options?: FolderTreeOptions) {
    if (!options?.allowedResourceIds?.length) return super.getFolderTree(options);
    return super.getFolderTree({
      ...options,
      allowedResourceIds: await rootCaIds(this.database, options.allowedResourceIds),
    });
  }

  private async rows(ids: readonly string[]) {
    const rows = await this.database
      .select({
        id: certificateAuthorities.id,
        parentId: certificateAuthorities.parentId,
        isSystem: certificateAuthorities.isSystem,
      })
      .from(certificateAuthorities)
      .where(inArray(certificateAuthorities.id, [...ids]));
    if (rows.length !== new Set(ids).size) throw new AppError(404, 'CA_NOT_FOUND', 'Certificate Authority not found');
    return rows;
  }
}

/**
 * PKI certificates have no edit scope: placing one needs `pki:cert:issue` on its issuing CA, and
 * certificates of system CAs never move.
 */
export class CertificateFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: pkiCertificateFolders,
      resourceTable: certificates,
      resourceName: 'certificate',
      resourcePlural: 'certificates',
      auditResourceType: 'pki_certificate_folder',
      eventName: 'cert.folder.changed',
    });
  }

  /** Issuing CA of each certificate; 404 when one does not exist. */
  async issuingCaIds(ids: readonly string[]): Promise<Map<string, { caId: string; isSystem: boolean }>> {
    const rows = await this.database
      .select({ id: certificates.id, caId: certificates.caId, isSystem: certificateAuthorities.isSystem })
      .from(certificates)
      .innerJoin(certificateAuthorities, eq(certificateAuthorities.id, certificates.caId))
      .where(inArray(certificates.id, [...ids]));
    if (rows.length !== new Set(ids).size) throw new AppError(404, 'CERT_NOT_FOUND', 'Certificate not found');
    return new Map(rows.map((row) => [row.id, { caId: row.caId, isSystem: row.isSystem }]));
  }

  /** Every certificate must be issued by a CA the caller may issue from (`pki:cert:issue:<caId>`). */
  async assertPlacementAccess(scopes: readonly string[], ids: readonly string[]) {
    for (const { caId } of (await this.issuingCaIds(ids)).values()) {
      if (!hasScopeForResource([...scopes], 'pki:cert:issue', caId)) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: pki:cert:issue:${caId}`);
      }
    }
  }

  override async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    await this.assertMovable(input.ids);
    return super.moveResourcesToFolder(input, userId);
  }

  override async reorderResources(input: ReorderResourcesInput) {
    await this.assertMovable(input.items.map((item) => item.id));
    return super.reorderResources(input);
  }

  /** A folder move re-places every certificate inside it: the caller must be allowed to place each one. */
  override async moveFolder(id: string, input: MoveResourceFolderInput, userId: string, access?: FolderMoveAccess) {
    if (access) {
      const folderIds = await this.subtreeFolderIds(id);
      const inside = folderIds.length
        ? await this.database
            .select({ id: certificates.id })
            .from(certificates)
            .where(inArray(certificates.folderId, folderIds))
        : [];
      if (inside.length) {
        await this.assertPlacementAccess(
          access.scopes,
          inside.map((row) => row.id)
        );
      }
    }
    return super.moveFolder(id, input, userId);
  }

  private async assertMovable(ids: readonly string[]) {
    const rows = await this.issuingCaIds(ids);
    if ([...rows.values()].some((row) => row.isSystem)) {
      throw new AppError(409, 'PKI_SYSTEM_CERT_FOLDER_LOCKED', 'System certificate placement cannot be changed');
    }
  }

  private async subtreeFolderIds(folderId: string): Promise<string[]> {
    const rows = await this.database
      .select({ id: pkiCertificateFolders.id, parentId: pkiCertificateFolders.parentId })
      .from(pkiCertificateFolders);
    const ids = new Set(rows.some((row) => row.id === folderId) ? [folderId] : []);
    for (let grew = ids.size > 0; grew; ) {
      grew = false;
      for (const row of rows) {
        if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
          ids.add(row.id);
          grew = true;
        }
      }
    }
    return [...ids];
  }
}

/** Custom certificate templates only: built-ins stay in the read-only built-in group. */
export class PkiTemplateFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: pkiTemplateFolders,
      resourceTable: certificateTemplates,
      resourceName: 'pki_template',
      resourcePlural: 'pki_templates',
      auditResourceType: 'pki_template_folder',
      eventName: 'pki.template.folder.changed',
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
      .select({ id: certificateTemplates.id, isBuiltin: certificateTemplates.isBuiltin })
      .from(certificateTemplates)
      .where(inArray(certificateTemplates.id, [...ids]));
    if (rows.length !== new Set(ids).size) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    if (rows.some((row) => row.isBuiltin)) {
      throw new AppError(400, 'BUILTIN_TEMPLATE_FOLDER_LOCKED', 'Built-in templates cannot be placed in folders');
    }
  }
}
