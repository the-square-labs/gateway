import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import type { User } from '@/types.js';
import { managePages, uploadPagesArtifact } from './ai.pages-tools.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_LIST_ID = '22222222-2222-4222-8222-222222222222';

function registerPages() {
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
    requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
  container.registerInstance(PageProfileService, {
    requireEnabled: vi.fn().mockResolvedValue(undefined),
  } as unknown as PageProfileService);
}

afterEach(() => container.reset());

describe('Pages MCP upload options', () => {
  it('accepts a single HTML file and an expiry at begin', async () => {
    registerPages();
    const create = vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' }, upload: { id: 'upload-1' } });
    container.registerInstance(PageDeploymentService, { create } as unknown as PageDeploymentService);
    const user = { id: 'user-1', scopes: [`pages:deploy:${PROJECT_ID}`] } as User;

    await uploadPagesArtifact(user, {
      operation: 'begin',
      projectId: PROJECT_ID,
      declaredSizeBytes: 42,
      sha256: 'a'.repeat(64),
      format: 'html',
      expiresInHours: 48,
      tag: 'demo',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'html', expiresInHours: 48, tag: 'demo' }),
      expect.objectContaining({ kind: 'user' })
    );
  });

  it('passes a finalize expiry and returns the preview links after publication', async () => {
    registerPages();
    const finalize = vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' } });
    const links = {
      preview: { hostname: 'a.pages.example', url: 'https://a.pages.example', status: 'ready', reason: null },
      tag: { name: 'demo', hostname: null, url: null, status: 'pending', reason: 'publishing' },
      latest: null,
    };
    const publicationLinks = vi.fn().mockResolvedValue(links);
    const markDeploymentReady = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(PageDeploymentService, {
      finalize,
      publicationLinks,
      get: vi.fn().mockResolvedValue({ id: 'deployment-1', status: 'ready' }),
    } as unknown as PageDeploymentService);
    container.registerInstance(PagePublicationService, { markDeploymentReady } as unknown as PagePublicationService);
    const user = { id: 'user-1', scopes: [`pages:deploy:${PROJECT_ID}`] } as User;
    const expiresAt = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const result = await uploadPagesArtifact(user, { operation: 'finalize', uploadId: 'upload-1', expiresAt });

    expect(finalize).toHaveBeenCalledWith('upload-1', expect.objectContaining({ kind: 'user' }), {
      expiresAt: new Date(expiresAt),
    });
    expect(markDeploymentReady.mock.invocationCallOrder[0]).toBeLessThan(
      publicationLinks.mock.invocationCallOrder[0] as number
    );
    expect(result).toEqual({ deployment: { id: 'deployment-1', status: 'ready' }, links });
  });

  it('rejects an expiry in the past before finalizing', async () => {
    registerPages();
    const finalize = vi.fn();
    container.registerInstance(PageDeploymentService, { finalize } as unknown as PageDeploymentService);
    const user = { id: 'user-1', scopes: [`pages:deploy:${PROJECT_ID}`] } as User;

    await expect(
      uploadPagesArtifact(user, {
        operation: 'finalize',
        uploadId: 'upload-1',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'PAGES_DEPLOYMENT_EXPIRY_INVALID' });
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('Pages MCP project preview settings', () => {
  it('rotates preview links with pages:edit on the Project', async () => {
    registerPages();
    const rotatePreviewHash = vi.fn().mockResolvedValue({ project: { id: PROJECT_ID }, rotation: {} });
    container.registerInstance(PageProjectService, { rotatePreviewHash } as unknown as PageProjectService);

    await expect(
      managePages({ id: 'user-1', scopes: [`pages:view:${PROJECT_ID}`] } as User, {
        operation: 'project_rotate_preview_hash',
        projectId: PROJECT_ID,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await managePages({ id: 'user-1', scopes: [`pages:edit:${PROJECT_ID}`] } as User, {
      operation: 'project_rotate_preview_hash',
      projectId: PROJECT_ID,
    });
    expect(rotatePreviewHash).toHaveBeenCalledWith(PROJECT_ID, 'user-1');
  });

  it('requires acl:view on a newly attached access list, like proxy hosts', async () => {
    registerPages();
    const update = vi.fn().mockResolvedValue({ id: PROJECT_ID });
    const get = vi.fn().mockResolvedValue({ id: PROJECT_ID, accessListId: null });
    container.registerInstance(PageProjectService, { update, get } as unknown as PageProjectService);
    const editor = { id: 'user-1', scopes: [`pages:edit:${PROJECT_ID}`] } as User;

    await expect(
      managePages(editor, { operation: 'project_update', projectId: PROJECT_ID, accessListId: ACCESS_LIST_ID })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(update).not.toHaveBeenCalled();

    await managePages(
      { ...editor, scopes: [...editor.scopes, `acl:view:${ACCESS_LIST_ID}`] },
      { operation: 'project_update', projectId: PROJECT_ID, accessListId: ACCESS_LIST_ID }
    );
    expect(update).toHaveBeenCalledWith(PROJECT_ID, { accessListId: ACCESS_LIST_ID }, 'user-1');

    // Removing the list needs no access-list scope.
    await managePages(editor, { operation: 'project_update', projectId: PROJECT_ID, accessListId: null });
    expect(update).toHaveBeenLastCalledWith(PROJECT_ID, { accessListId: null }, 'user-1');
  });

  it('returns the preview links of one Deployment with pages:view', async () => {
    registerPages();
    const links = { preview: { status: 'ready' }, tag: null, latest: null };
    container.registerInstance(PageProjectService, {} as PageProjectService);
    container.registerInstance(PageDeploymentService, {
      getForProject: vi.fn().mockResolvedValue({ id: 'deployment-1' }),
      publicationLinks: vi.fn().mockResolvedValue(links),
    } as unknown as PageDeploymentService);

    await expect(
      managePages({ id: 'user-1', scopes: [`pages:view:${PROJECT_ID}`] } as User, {
        operation: 'deployment_links',
        projectId: PROJECT_ID,
        deploymentId: 'deployment-1',
      })
    ).resolves.toEqual(links);
  });
});
