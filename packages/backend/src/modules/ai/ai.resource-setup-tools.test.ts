import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import type { User } from '@/types.js';
import { executeResourceSetupTool } from './ai.resource-setup-tools.js';

const USER = {
  id: 'user-1',
  scopes: ['pages:tokens:manage:project-1', 'databases:edit:database-1'],
} as User;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => container.reset());

describe('resource setup AI tools', () => {
  it('uploads a Pages artifact through resumable MCP operations without credential arguments', async () => {
    const create = vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' }, upload: { id: 'upload-1' } });
    const appendChunk = vi.fn().mockResolvedValue({ id: 'upload-1', offset: 4, complete: true });
    const finalize = vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' } });
    const get = vi.fn().mockResolvedValue({ id: 'deployment-1', status: 'ready' });
    const markDeploymentReady = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockResolvedValue(undefined),
    } as unknown as LicensePolicyService);
    container.registerInstance(PageProfileService, {
      requireEnabled: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageProfileService);
    container.registerInstance(PageDeploymentService, {
      create,
      appendChunk,
      finalize,
      get,
    } as unknown as PageDeploymentService);
    container.registerInstance(PagePublicationService, {
      markDeploymentReady,
    } as unknown as PagePublicationService);
    const user = { ...USER, scopes: [`pages:deploy:${PROJECT_ID}`] };

    await expect(
      executeResourceSetupTool(user, 'upload_pages_artifact', {
        operation: 'begin',
        projectId: PROJECT_ID,
        declaredSizeBytes: 4,
        sha256: 'a'.repeat(64),
        source: {},
      })
    ).resolves.toMatchObject({ upload: { id: 'upload-1' } });
    await expect(
      executeResourceSetupTool(user, 'upload_pages_artifact', {
        operation: 'chunk',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: Buffer.from('test').toString('base64'),
      })
    ).resolves.toMatchObject({ offset: 4, complete: true });
    await expect(
      executeResourceSetupTool(user, 'upload_pages_artifact', {
        operation: 'finalize',
        uploadId: 'upload-1',
      })
    ).resolves.toEqual({ deployment: { id: 'deployment-1', status: 'ready' } });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, declaredSizeBytes: 4 }), {
      kind: 'user',
      userId: 'user-1',
      scopes: [`pages:deploy:${PROJECT_ID}`],
    });
    expect(appendChunk).toHaveBeenCalledWith('upload-1', 0, Buffer.from('test'), {
      kind: 'user',
      userId: 'user-1',
      scopes: [`pages:deploy:${PROJECT_ID}`],
    });
    expect(markDeploymentReady).toHaveBeenCalledWith('deployment-1');
  });

  it('rejects malformed or oversized MCP Pages chunks before storage', async () => {
    const appendChunk = vi.fn();
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockResolvedValue(undefined),
    } as unknown as LicensePolicyService);
    container.registerInstance(PageProfileService, {
      requireEnabled: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageProfileService);
    container.registerInstance(PageDeploymentService, { appendChunk } as unknown as PageDeploymentService);
    const user = { ...USER, scopes: [`pages:deploy:${PROJECT_ID}`] };

    await expect(
      executeResourceSetupTool(user, 'upload_pages_artifact', {
        operation: 'chunk',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: 'not base64',
      })
    ).rejects.toMatchObject({ code: 'PAGES_UPLOAD_CHUNK_INVALID' });
    await expect(
      executeResourceSetupTool(user, 'upload_pages_artifact', {
        operation: 'chunk',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
      })
    ).rejects.toMatchObject({ code: 'PAGES_UPLOAD_CHUNK_TOO_LARGE' });
    expect(appendChunk).not.toHaveBeenCalled();
  });

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
