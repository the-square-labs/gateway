import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { IntegrationsService } from './integrations.service.js';

function fixture(enabled = true) {
  const connector = { id: 'connector-1', provider: 'github', name: 'GitHub', enabled, encryptedToken: 'encrypted' };
  const personal = vi.fn().mockResolvedValue(null);
  const connectorToken = vi.fn().mockResolvedValue('connector-token');
  const request = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          id: 123,
          name: 'app',
          full_name: 'owner/app',
          html_url: 'https://github.com/owner/app',
          default_branch: 'main',
        },
      ]),
      { status: 200 }
    )
  );
  const service = Object.assign(Object.create(IntegrationsService.prototype), {
    getConnectorRow: vi.fn().mockResolvedValue(connector),
    resolveGitHubConnectorToken: connectorToken,
    githubConnectorRequest: request,
    gitLabUserCredentials: { resolveAuth: personal },
    upsertProjectRows: vi.fn(),
    db: { select: () => ({ from: () => ({ where: async () => [{ id: 'project-1', remoteId: '123' }] }) }) },
  }) as IntegrationsService;
  return { service, personal, connectorToken, request };
}

describe('PaaS repository discovery credentials', () => {
  it('uses the connector for a Docker-only user while ordinary browsing still requires personal authorization', async () => {
    const { service, personal, connectorToken, request } = fixture();
    const user = { id: 'user-1', scopes: ['docker:containers:view'] } as User;
    await expect(service.listDockerBuildSourceRepositories(user, 'connector-1')).resolves.toMatchObject([
      { connectorId: 'connector-1', projectId: 'project-1', fullPath: 'owner/app' },
    ]);
    expect(connectorToken).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'connector-1' }),
      'connector-token',
      expect.any(String)
    );
    expect(personal).not.toHaveBeenCalled();
    expect(user.scopes).toEqual(['docker:containers:view']);
    await expect(service.githubListRepositories(user, { connectorId: 'connector-1' })).rejects.toMatchObject({
      code: 'CONNECTOR_SCOPE_DENIED',
    });
    await expect(
      service.githubListRepositories({ ...user, scopes: ['integrations:github:view'] }, { connectorId: 'connector-1' })
    ).rejects.toThrow(/personal|Personal/);
    expect(personal).toHaveBeenCalledOnce();
  });

  it('rejects a disabled connector before reading any credential', async () => {
    const { service, personal, connectorToken, request } = fixture(false);
    await expect(
      service.listDockerBuildSourceRepositories(
        { id: 'user-1', scopes: ['docker:containers:view'] } as User,
        'connector-1'
      )
    ).rejects.toMatchObject({ code: 'CONNECTOR_DISABLED' });
    expect(connectorToken).not.toHaveBeenCalled();
    expect(personal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
