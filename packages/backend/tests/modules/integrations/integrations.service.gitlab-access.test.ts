import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import {
  BASE_USER,
  connectorRow,
  createCloudflareDeleteInUseDb,
  createDockerSourceListDb,
  createDockerSourceResolveDb,
  createGetDb,
  createGetUpdateDb,
  createListDb,
  createProjectActionDb,
  createToolProjectsDb,
  projectRow,
  vcsProvider,
} from './integrations.service.test-support.js';

describe('IntegrationsService', () => {
  it('lists only allowlisted GitLab projects for AI tools', async () => {
    const db = createToolProjectsDb({
      connector: connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }),
      projects: [
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          remoteId: '10',
          fullPath: 'helmut/link4work',
          name: 'link4work',
          webUrl: 'https://gitlab.example.com/helmut/link4work',
          visibility: 'private',
          defaultBranch: 'main',
          archived: false,
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          inaccessibleAt: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          remoteId: '11',
          fullPath: 'allowed/app',
          name: 'app',
          webUrl: 'https://gitlab.example.com/allowed/app',
          visibility: 'private',
          defaultBranch: 'main',
          archived: false,
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          inaccessibleAt: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      allowlistEntries: [{ entryType: 'project', remoteId: '11', fullPath: 'allowed/app', name: null, webUrl: null }],
    });
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );

    const result = await service.listGitLabProjectsForTool(
      { ...BASE_USER, scopes: ['integrations:gitlab:projects:view', 'integrations:gitlab:system'] },
      { connectorId: '11111111-1111-4111-8111-111111111111', search: 'link', limit: 10 }
    );

    expect(result).toMatchObject({ data: [], total: 0, truncated: false });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          returned: 0,
          totalMatched: 0,
        }),
      })
    );
  });

  it('requires a personal PAT without falling back to the system credential', async () => {
    const decryptString = vi.fn(() => 'glpat-system-token');
    const db = createToolProjectsDb({
      connector: connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }),
      projects: [projectRow()],
      allowlistEntries: [],
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue(null);

    await expect(
      service.listGitLabProjectsForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111' }
      )
    ).rejects.toMatchObject({
      statusCode: 428,
      code: 'GITLAB_CREDENTIAL_REQUIRED',
      details: expect.objectContaining({ reason: 'missing' }),
    });
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('lists allowlisted Docker build repositories with the connector-owned GitLab credential model', async () => {
    const connector = connectorRow({ capabilities: { projectsView: true, repoRead: true } });
    const project = projectRow();
    const db = createDockerSourceListDb({
      connector,
      projects: [project, projectRow({ remoteId: '29', fullPath: 'blocked/app', name: 'blocked' })],
      allowlistEntries: [
        { entryType: 'project', remoteId: project.remoteId, fullPath: project.fullPath, name: null, webUrl: null },
      ],
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    const resolveAuth = vi.spyOn(credentials, 'resolveAuth');

    await expect(
      service.listDockerBuildSourceRepositories(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:read'] },
        connector.id
      )
    ).resolves.toEqual([
      expect.objectContaining({
        connectorId: connector.id,
        projectId: project.id,
        provider: 'gitlab',
        remoteId: project.remoteId,
        fullPath: project.fullPath,
      }),
    ]);
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it('resolves an immutable Docker build commit with the connector-owned GitLab credential', async () => {
    const connector = connectorRow({
      capabilities: { projectsView: true, repoRead: true },
      encryptedToken: JSON.stringify({ encryptedKey: 'key', encryptedDek: 'dek' }),
    });
    const project = projectRow();
    const db = createDockerSourceResolveDb({
      connector,
      project,
      allowlistEntries: [
        { entryType: 'project', remoteId: project.remoteId, fullPath: project.fullPath, name: null, webUrl: null },
      ],
    });
    const provider = vcsProvider({
      getBranchAccess: vi.fn().mockResolvedValue({
        exists: true,
        canPush: false,
        commitSha: 'a'.repeat(40),
      }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);

    await expect(
      service.resolveDockerBuildSource(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:read'] },
        { connectorId: connector.id, projectId: project.id, branch: 'main' }
      )
    ).resolves.toMatchObject({
      connectorId: connector.id,
      projectId: project.id,
      branch: 'main',
      commitSha: 'a'.repeat(40),
      cloneUrl: 'https://gitlab.example.com/general/balanceify.git',
    });
    expect(provider.getBranchAccess).toHaveBeenCalledWith(
      { baseUrl: 'https://gitlab.example.com', token: 'glpat-system-token' },
      expect.objectContaining({ remoteId: project.remoteId, fullPath: project.fullPath }),
      'main'
    );
  });

  it('intersects cached allowlisted projects with projects visible to the personal PAT', async () => {
    const cachedProjects = [projectRow(), projectRow({ remoteId: '29', fullPath: 'general/private', name: 'private' })];
    const db = createToolProjectsDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      projects: cachedProjects,
      allowlistEntries: [],
    });
    const provider = vcsProvider({
      listProjects: vi.fn().mockResolvedValue([
        {
          remoteId: '28',
          fullPath: 'general/balanceify',
          name: 'balanceify',
          webUrl: 'https://gitlab.example.com/general/balanceify',
        },
      ]),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.listGitLabProjectsForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111' }
      )
    ).resolves.toMatchObject({
      total: 1,
      data: [expect.objectContaining({ remoteId: '28', fullPath: 'general/balanceify' })],
    });
    expect(provider.listProjects).toHaveBeenCalledWith(expect.objectContaining({ token: 'glpat-personal-token' }));
  });

  it('creates commits with the personal PAT after checking its write access', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        commitMessage: 'Update file',
        changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
      }
    );

    expect(provider.getProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' })
    );
    expect(provider.getBranchAccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'main'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ commitMessage: 'Update file' })
    );
  });

  it('refuses personal commits without push access to an existing branch', async () => {
    const branchAccess = { exists: true, canPush: false };
    const branch = 'main';
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue(branchAccess),
      commitFiles: vi.fn(),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch,
          commitMessage: 'Update file',
          changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'GITLAB_PERSONAL_BRANCH_WRITE_ACCESS_REQUIRED' });
    expect(provider.commitFiles).not.toHaveBeenCalled();
  });

  it('creates a missing branch and commits with the personal PAT', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: false, canPush: false }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', webUrl: null }),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'feature/new',
        startBranch: 'main',
        commitMessage: 'Add feature',
        changes: [{ action: 'create', path: 'feature.txt', content: 'new' }],
      }
    );

    expect(provider.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'feature/new',
      'main'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ branch: 'feature/new', startBranch: undefined })
    );
  });

  it('commits a valid CI configuration with the personal PAT', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciEdit: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabUpdateCiConfig(
      { ...BASE_USER, scopes: ['integrations:gitlab:ci:edit'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        content: 'stages: [test]\n',
        commitMessage: 'Update CI',
      }
    );

    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ changes: [{ action: 'update', path: '.gitlab-ci.yml', content: 'stages: [test]\n' }] })
    );
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('uses the system PAT for a commit only when the caller has the explicit system scope', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write', 'integrations:gitlab:system'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        commitMessage: 'Update file',
        changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
      }
    );

    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-system-token' }),
      expect.objectContaining({ commitMessage: 'Update file' })
    );
  });

  it('invalidates a personal PAT when a GitLab write returns 401', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      commitFiles: vi.fn().mockRejectedValue(new AppError(401, 'GITLAB_API_ERROR', 'Unauthorized')),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as {
        gitLabUserCredentials: {
          resolveAuth: (...args: unknown[]) => Promise<unknown>;
          markInvalid: (...args: unknown[]) => Promise<void>;
        };
      }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });
    const markInvalid = vi.spyOn(credentials, 'markInvalid').mockResolvedValue(undefined);

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch: 'main',
          commitMessage: 'Update file',
          changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 428, code: 'GITLAB_CREDENTIAL_REQUIRED' });
    expect(markInvalid).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
  });

  it('requires startBranch when a personal PAT targets a missing branch', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: false, canPush: false }),
      commitFiles: vi.fn(),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch: 'feature/new',
          commitMessage: 'Add feature',
          changes: [{ action: 'create', path: 'feature.txt', content: 'new' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'GITLAB_START_BRANCH_REQUIRED' });
    expect(provider.createBranch).not.toHaveBeenCalled();
    expect(provider.commitFiles).not.toHaveBeenCalled();
  });

});
