import { describe, expect, it, vi } from 'vitest';
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
});
