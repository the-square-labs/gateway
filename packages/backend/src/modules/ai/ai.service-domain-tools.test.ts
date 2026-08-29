import { describe, expect, it, vi } from 'vitest';
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
    expect(domainsService.listDomains).toHaveBeenCalledWith({ search: 'example', page: 2, limit: 25 });

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
      { domain: 'example.com', description: undefined, ttl: 60, proxied: false, overwriteDns: true },
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
    ).resolves.toMatchObject({ error: expect.stringContaining('integrations:cloudflare:dns:edit') });

    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [
            'domains:view',
            'domains:view:domain-1',
            'domains:edit:domain-1',
            'integrations:cloudflare:dns:edit',
          ],
        },
        'manage_domain',
        {
          operation: 'update',
          domainId: 'domain-1',
          proxied: false,
        }
      )
    ).resolves.toMatchObject({ result: { id: 'domain-1' }, invalidateStores: ['domains'] });

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
});
