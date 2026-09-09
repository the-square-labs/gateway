import { describe, expect, it } from 'vitest';
import type { User } from '@/types.js';
import { IntegrationsGitRepositoryService } from './integrations.service.git-repositories.js';

describe('Git repository permission diagnostics', () => {
  it.each([
    ['githubUpsertRepositoryFile', 'integrations:github:manage'],
    ['githubUpsertActionsVariable', 'integrations:github:manage'],
    ['githubUpsertActionsSecret', 'integrations:github:manage'],
    ['gitUpsertRepositoryFile', 'integrations:git:manage'],
  ] as const)('%s names the checked permission before resolving credentials', async (method, requiredScope) => {
    // No dependencies: a denial must occur before repository/credential resolution.
    const service = Object.create(IntegrationsGitRepositoryService.prototype) as IntegrationsGitRepositoryService;
    await expect(
      service[method]({ id: 'user-1', scopes: [] } as unknown as User, {
        connectorId: 'connector-1',
        repositoryUrl: 'https://example.invalid/repo.git',
        path: 'file.txt',
        branch: 'main',
        message: 'test',
        content: 'test',
        name: 'TEST',
        value: 'test-secret',
      })
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      message: expect.stringContaining(`Required permission: ${requiredScope}`),
      details: { requiredScope },
    });
  });
});
