import { describe, expect, it, vi } from 'vitest';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';
import { SSLCertificateFolderService } from './ssl-certificate-folders.service.js';

function serviceWithSystemCertificate() {
  const limit = vi.fn().mockResolvedValue([{ id: 'system-cert' }]);
  const database = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
  };
  const service = new SSLCertificateFolderService(
    database as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never
  );
  return { service, database };
}

describe('SSLCertificateFolderService', () => {
  it('blocks direct movement and reordering of system certificates', async () => {
    const { service } = serviceWithSystemCertificate();

    await expect(
      service.moveResourcesToFolder({ ids: ['system-cert'], folderId: null }, 'user-1')
    ).rejects.toMatchObject({ code: 'SSL_SYSTEM_CERT_FOLDER_LOCKED', statusCode: 409 });
    await expect(service.reorderResources({ items: [{ id: 'system-cert', sortOrder: 0 }] })).rejects.toMatchObject({
      code: 'SSL_SYSTEM_CERT_FOLDER_LOCKED',
      statusCode: 409,
    });
  });

  it('blocks moving or deleting folders that contain system certificates', async () => {
    const { service } = serviceWithSystemCertificate();
    vi.spyOn(service, 'getFolderTree').mockResolvedValue([
      {
        id: 'folder-1',
        name: 'TLS',
        parentId: null,
        sortOrder: 0,
        depth: 0,
        createdById: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        children: [],
      },
    ]);

    await expect(service.moveFolder('folder-1', { parentId: null }, 'user-1')).rejects.toMatchObject({
      code: 'SSL_SYSTEM_CERT_FOLDER_LOCKED',
      statusCode: 409,
    });
    await expect(service.deleteFolder('folder-1', 'user-1')).rejects.toMatchObject({
      code: 'SSL_SYSTEM_CERT_FOLDER_LOCKED',
      statusCode: 409,
    });
  });

  it('forwards the caller access to the base folder move so per-certificate checks run', async () => {
    const { service } = serviceWithSystemCertificate();
    vi.spyOn(service, 'getFolderTree').mockResolvedValue([]);
    const baseMove = vi
      .spyOn(FolderedResourceService.prototype, 'moveFolder')
      .mockResolvedValue({ id: 'folder-1' } as never);
    const access = { scopes: ['ssl:cert:folders:manage'], editScope: 'ssl:cert:issue' };

    await service.moveFolder('folder-1', { parentId: 'folder-2' }, 'user-1', access);

    expect(baseMove).toHaveBeenCalledWith('folder-1', { parentId: 'folder-2' }, 'user-1', access);
    baseMove.mockRestore();
  });
});
