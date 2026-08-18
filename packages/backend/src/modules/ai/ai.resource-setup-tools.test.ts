import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import type { User } from '@/types.js';
import { executeResourceSetupTool } from './ai.resource-setup-tools.js';

const USER = {
  id: 'user-1',
  scopes: ['pages:tokens:manage:project-1', 'databases:edit:database-1'],
} as User;

afterEach(() => container.reset());

describe('resource setup AI tools', () => {
  it('dispatches the complete Pages deploy-token lifecycle with project scope', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 'token-1' }]);
    const create = vi.fn().mockResolvedValue({ id: 'token-1', token: 'gwp_once' });
    const revoke = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockResolvedValue(undefined),
    } as unknown as LicensePolicyService);
    container.registerInstance(PageProjectService, {} as PageProjectService);
    container.registerInstance(PageProfileService, {
      requireEnabled: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageProfileService);
    container.registerInstance(PageDeployTokenService, { list, create, revoke } as unknown as PageDeployTokenService);

    await expect(
      executeResourceSetupTool(USER, 'manage_pages', { operation: 'token_list', projectId: 'project-1' })
    ).resolves.toEqual([{ id: 'token-1' }]);
    await expect(
      executeResourceSetupTool(USER, 'manage_pages', {
        operation: 'token_create',
        projectId: 'project-1',
        name: 'CI',
        allowedTagPatterns: ['mr-*'],
        allowUserTag: true,
      })
    ).resolves.toMatchObject({ id: 'token-1', token: 'gwp_once' });
    await expect(
      executeResourceSetupTool(USER, 'manage_pages', {
        operation: 'token_revoke',
        projectId: 'project-1',
        tokenId: 'token-1',
      })
    ).resolves.toEqual({ success: true });

    expect(create).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ name: 'CI', allowedTagPatterns: ['mr-*'], allowUserTag: true }),
      'user-1'
    );
    expect(revoke).toHaveBeenCalledWith('project-1', 'token-1', 'user-1');
  });

  it('dispatches safe managed-database lifecycle operations', async () => {
    const service = {
      update: vi.fn().mockResolvedValue({ id: 'database-1', memoryMb: 1024 }),
      restart: vi.fn().mockResolvedValue({ id: 'database-1', status: 'updating' }),
      pause: vi.fn().mockResolvedValue({ id: 'database-1', status: 'paused' }),
      unpause: vi.fn().mockResolvedValue({ id: 'database-1', status: 'ready' }),
      rotateCertificate: vi.fn().mockResolvedValue({ id: 'database-1', certificateVersion: 2 }),
    };
    container.registerInstance(ManagedDatabaseService, service as unknown as ManagedDatabaseService);
    container.registerInstance(ManagedDatabaseBindingService, {} as ManagedDatabaseBindingService);

    await executeResourceSetupTool(USER, 'manage_managed_database', {
      operation: 'update',
      databaseId: 'database-1',
      memoryMb: 1024,
    });
    for (const operation of ['restart', 'pause', 'unpause', 'rotate_certificate'] as const) {
      await executeResourceSetupTool(USER, 'manage_managed_database', { operation, databaseId: 'database-1' });
    }

    expect(service.update).toHaveBeenCalledWith('database-1', { memoryMb: 1024 }, 'user-1');
    expect(service.restart).toHaveBeenCalledWith('database-1', 'user-1');
    expect(service.pause).toHaveBeenCalledWith('database-1', 'user-1');
    expect(service.unpause).toHaveBeenCalledWith('database-1', 'user-1');
    expect(service.rotateCertificate).toHaveBeenCalledWith('database-1', 'user-1');
  });
});
