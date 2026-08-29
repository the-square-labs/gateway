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
  it('refreshes capabilities with the personal PAT without touching the system credential', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciLint: false },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      testConnection: vi.fn().mockResolvedValue({ projectsView: true, ciLint: true }),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 20 }),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
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

    await expect(
      service.gitLabLintCiConfig(
        { ...BASE_USER, scopes: ['integrations:gitlab:ci:view'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          content: 'stages: [test]\n',
        }
      )
    ).resolves.toMatchObject({ valid: true });

    expect(provider.testConnection).toHaveBeenCalledWith(expect.objectContaining({ token: 'glpat-personal-token' }));
    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
    expect(decryptString).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('invalidates a personal PAT after a GitLab 401 and requests authorization again', async () => {
    const db = createProjectActionDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      project: projectRow(),
      allowlistEntries: [],
    });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockRejectedValue(new AppError(401, 'GITLAB_API_ERROR', 'Unauthorized')),
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
      service.getGitLabProjectForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111', project: 'general/balanceify' }
      )
    ).rejects.toMatchObject({
      statusCode: 428,
      code: 'GITLAB_CREDENTIAL_REQUIRED',
      details: expect.objectContaining({ reason: 'invalid' }),
    });
    expect(markInvalid).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
  });

  it('does not invalidate a personal PAT after a GitLab 403', async () => {
    const db = createProjectActionDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      project: projectRow(),
      allowlistEntries: [],
    });
    const forbidden = new AppError(403, 'GITLAB_API_ERROR', 'Forbidden');
    const provider = vcsProvider({ getProjectAccess: vi.fn().mockRejectedValue(forbidden) });
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
      service.getGitLabProjectForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111', project: 'general/balanceify' }
      )
    ).rejects.toBe(forbidden);
    expect(markInvalid).not.toHaveBeenCalled();
  });

  it('refreshes stale GitLab capabilities before denying a project tool action', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciLint: false },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const project = {
      id: 'project-row-1',
      connectorId: '11111111-1111-4111-8111-111111111111',
      remoteId: '28',
      fullPath: 'general/balanceify',
      name: 'balanceify',
      webUrl: 'https://gitlab.example.com/general/balanceify',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      inaccessibleAt: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const db = createProjectActionDb({ connector, project, allowlistEntries: [] });
    const provider = {
      provider: 'gitlab',
      testConnection: vi.fn().mockResolvedValue({ projectsView: true, ciLint: true }),
      searchAllowlist: vi.fn(),
      listProjects: vi.fn(),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      listRegistries: vi.fn(),
      listTree: vi.fn(),
      readFile: vi.fn(),
      commitFiles: vi.fn(),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
      listPipelines: vi.fn(),
      getPipeline: vi.fn(),
      listPipelineJobs: vi.fn(),
      getJobLog: vi.fn(),
      listProjectVariables: vi.fn(),
      setProjectVariable: vi.fn(),
      deleteProjectVariable: vi.fn(),
      listProjectWebhooks: vi.fn(),
      createOrUpdateProjectWebhook: vi.fn(),
      deleteProjectWebhook: vi.fn(),
      listRegistryRepositories: vi.fn(),
      createDeployToken: vi.fn(),
      updateProjectSettings: vi.fn(),
      downloadRepositoryArchive: vi.fn(),
    };
    const cryptoService = { decryptString: vi.fn(() => 'glpat-token') };
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(db as never, auditService as never, cryptoService as never);
    service.registerProvider(provider as never);

    await expect(
      service.gitLabLintCiConfig(
        { ...BASE_USER, scopes: ['integrations:gitlab:ci:view', 'integrations:gitlab:system'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          content: 'stages: [test]\n',
        }
      )
    ).resolves.toMatchObject({ valid: true });

    expect(provider.testConnection).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat-token',
    });
    expect(db.update).toHaveBeenCalled();
    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
  });

  it('syncs the GitLab connector after updating project registry settings', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, deployTokensManage: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const project = {
      id: 'project-row-1',
      connectorId: '11111111-1111-4111-8111-111111111111',
      remoteId: '28',
      fullPath: 'general/balanceify',
      name: 'balanceify',
      webUrl: 'https://gitlab.example.com/general/balanceify',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      inaccessibleAt: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const db = createProjectActionDb({ connector, project, allowlistEntries: [] });
    const provider = {
      provider: 'gitlab',
      testConnection: vi.fn(),
      searchAllowlist: vi.fn(),
      listProjects: vi.fn(),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      listRegistries: vi.fn(),
      listTree: vi.fn(),
      readFile: vi.fn(),
      commitFiles: vi.fn(),
      lintCiConfig: vi.fn(),
      listPipelines: vi.fn(),
      getPipeline: vi.fn(),
      listPipelineJobs: vi.fn(),
      getJobLog: vi.fn(),
      listProjectVariables: vi.fn(),
      setProjectVariable: vi.fn(),
      deleteProjectVariable: vi.fn(),
      listProjectWebhooks: vi.fn(),
      createOrUpdateProjectWebhook: vi.fn(),
      deleteProjectWebhook: vi.fn(),
      listRegistryRepositories: vi.fn(),
      createDeployToken: vi.fn(),
      updateProjectSettings: vi.fn().mockResolvedValue({
        remoteId: '28',
        fullPath: 'general/balanceify',
        name: 'balanceify',
        containerRegistryAccessLevel: 'enabled',
      }),
      downloadRepositoryArchive: vi.fn(),
    };
    const cryptoService = { decryptString: vi.fn(() => 'glpat-token') };
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(db as never, auditService as never, cryptoService as never);
    const syncGitLabConnector = vi
      .spyOn(service, 'syncGitLabConnector')
      .mockResolvedValue({ status: 'success', projectCount: 1, registryCount: 1, skippedRegistryProjects: [] });
    service.registerProvider(provider as never);

    await expect(
      service.gitLabUpdateProjectSettings(
        { ...BASE_USER, scopes: ['integrations:gitlab:registry:manage', 'integrations:gitlab:system'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          containerRegistryAccessLevel: 'enabled',
        }
      )
    ).resolves.toMatchObject({
      fullPath: 'general/balanceify',
      sync: { status: 'success', registryCount: 1 },
      syncError: null,
    });

    expect(provider.updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      { containerRegistryAccessLevel: 'enabled' }
    );
    expect(syncGitLabConnector).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'user-1');
  });

});
