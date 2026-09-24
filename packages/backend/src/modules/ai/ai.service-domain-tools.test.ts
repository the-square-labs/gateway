import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(domainsService: Record<string, unknown>) {
  container.registerInstance(DomainFolderService, {
    assertFolderExists: vi.fn().mockResolvedValue(undefined),
  } as never);
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    domainsService as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('AIService domain tool routing', () => {
  afterEach(() => container.reset());
  it('routes domain list/create/delete operations through the domains service', async () => {
    const domainsService = {
      listDomains: vi.fn().mockResolvedValue({ data: [{ id: 'domain-1' }], total: 1 }),
      createDomain: vi.fn().mockResolvedValue({ id: 'domain-2', domain: 'example.com' }),
      deleteDomain: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(domainsService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:view'] }, 'list_domains', {
        search: 'example',
        page: 2,
        limit: 25,
      })
    ).resolves.toEqual({ result: { data: [{ id: 'domain-1' }], total: 1 }, invalidateStores: [] });
    expect(domainsService.listDomains).toHaveBeenCalledWith(
      { search: 'example', page: 2, limit: 25 },
      { allowedIds: undefined }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['integrations:cloudflare:manage'] }, 'create_domain', {
        domain: 'example.com',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('domains:create'), invalidateStores: [] });
    expect(domainsService.createDomain).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:create'] }, 'create_domain', {
        domain: 'example.com',
        ttl: 60,
        proxied: false,
        overwriteDns: true,
      })
    ).resolves.toEqual({
      result: { id: 'domain-2', domain: 'example.com' },
      invalidateStores: ['domains'],
    });
    expect(domainsService.createDomain).toHaveBeenCalledWith(
      { domain: 'example.com', dnsProvider: 'cloudflare', ttl: 60, proxied: false, overwriteDns: true },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:delete'] }, 'delete_domain', {
        domainId: 'domain-1',
        deleteDns: false,
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['domains'] });
    expect(domainsService.deleteDomain).toHaveBeenCalledWith('domain-1', 'user-1', { deleteDns: false });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:delete'] }, 'delete_domain', {
        domainId: 'domain-1',
        deleteDns: true,
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['domains'] });
    expect(domainsService.deleteDomain).toHaveBeenLastCalledWith('domain-1', 'user-1', { deleteDns: true });
  });

  it('routes managed domain get/update/check operations with resource scopes', async () => {
    const domainsService = {
      getDomain: vi.fn().mockResolvedValue({ id: 'domain-1', description: 'old' }),
      updateDomain: vi.fn().mockResolvedValue({ id: 'domain-1', description: 'new' }),
      checkDns: vi.fn().mockResolvedValue({ id: 'domain-1', dnsStatus: 'valid' }),
    };
    const service = createService(domainsService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['integrations:cloudflare:view'] }, 'manage_domain', {
        operation: 'get',
        domainId: 'domain-1',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('domains:view'), invalidateStores: [] });
    expect(domainsService.getDomain).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:view', 'domains:view:domain-1'] }, 'manage_domain', {
        operation: 'get',
        domainId: 'domain-1',
      })
    ).resolves.toEqual({
      result: { id: 'domain-1', description: 'old' },
      invalidateStores: ['domains'],
    });
    expect(domainsService.getDomain).toHaveBeenCalledWith('domain-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['domains:view', 'domains:view:domain-1', 'domains:edit:domain-1'] },
        'manage_domain',
        {
          operation: 'update',
          domainId: 'domain-1',
          description: 'new',
        }
      )
    ).resolves.toEqual({
      result: { id: 'domain-1', description: 'new' },
      invalidateStores: ['domains'],
    });
    expect(domainsService.updateDomain).toHaveBeenCalledWith('domain-1', { description: 'new' }, 'user-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['domains:view', 'domains:view:domain-1', 'domains:edit:domain-1'] },
        'manage_domain',
        {
          operation: 'update',
          domainId: 'domain-1',
          proxied: false,
        }
      )
    ).resolves.toMatchObject({ result: { id: 'domain-1' }, invalidateStores: ['domains'] });
    // Like PUT /domains/{id}, toggling the Cloudflare proxy needs domains:edit only.
    expect(domainsService.updateDomain).toHaveBeenLastCalledWith('domain-1', { proxied: false }, 'user-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['domains:view', 'domains:view:domain-1', 'domains:edit:domain-1'] },
        'manage_domain',
        {
          operation: 'check_dns',
          domainId: 'domain-1',
        }
      )
    ).resolves.toEqual({
      result: { id: 'domain-1', dnsStatus: 'valid' },
      invalidateStores: ['domains'],
    });
    expect(domainsService.checkDns).toHaveBeenCalledWith('domain-1');
  });

  it('previews domains, lists ingress nodes, and resolves Cloudflare migrations with route scopes', async () => {
    const NODE_ID = '11111111-1111-4111-8111-111111111111';
    const domainsService = {
      getNginxNodeOptions: vi.fn().mockResolvedValue({ nodes: [{ id: NODE_ID }] }),
      previewDomain: vi.fn().mockResolvedValue({ dnsProvider: 'external', domain: 'example.com' }),
      resolveCloudflareMigration: vi.fn().mockResolvedValue({ id: 'domain-1', status: 'resolved' }),
    };
    const service = createService(domainsService);

    // GET /domains/nginx-nodes and POST /domains/preview require domains:create.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:view'] }, 'manage_domain', {
        operation: 'list_nginx_nodes',
      })
    ).resolves.toEqual({ error: 'Missing required scope: domains:create', invalidateStores: [] });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:create'] }, 'manage_domain', {
        operation: 'preview',
        domain: 'Example.com',
        dnsProvider: 'external',
        nginxNodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ result: { dnsProvider: 'external' } });
    expect(domainsService.previewDomain).toHaveBeenCalledWith({
      domain: 'example.com',
      dnsProvider: 'external',
      nginxNodeId: NODE_ID,
    });

    // update_dns needs a node; the service also checks proxy access with the caller scopes.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:edit:domain-1'] }, 'manage_domain', {
        operation: 'resolve_cloudflare_migration',
        domainId: 'domain-1',
        action: 'update_dns',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('nginxNodeId') });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:edit:domain-1'] }, 'manage_domain', {
        operation: 'resolve_cloudflare_migration',
        domainId: 'domain-1',
        action: 'update_dns',
        nginxNodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ result: { status: 'resolved' } });
    expect(domainsService.resolveCloudflareMigration).toHaveBeenCalledWith(
      'domain-1',
      { action: 'update_dns', nginxNodeId: NODE_ID },
      'user-1',
      ['domains:edit:domain-1']
    );
  });

  it('creates external-DNS domains with the route schema', async () => {
    const domainsService = { createDomain: vi.fn().mockResolvedValue({ id: 'domain-3' }) };
    const service = createService(domainsService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:create'] }, 'create_domain', {
        domain: 'not a domain',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Invalid domain name format') });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['domains:create'] }, 'create_domain', {
        domain: 'Ext.Example.com',
        dnsProvider: 'external',
      })
    ).resolves.toMatchObject({ result: { id: 'domain-3' } });
    expect(domainsService.createDomain).toHaveBeenCalledWith(
      { domain: 'ext.example.com', dnsProvider: 'external' },
      'user-1'
    );
  });
});
