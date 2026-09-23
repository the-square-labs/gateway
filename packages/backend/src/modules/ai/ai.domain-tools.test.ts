import { describe, expect, it, vi } from 'vitest';

vi.mock('@/container.js', () => ({ container: { resolve: vi.fn() } }));
vi.mock('@/modules/domains/domain-folders.service.js', () => ({ DomainFolderService: class DomainFolderService {} }));

import { executeDomainTool } from './ai.domain-tools.js';

describe('executeDomainTool list_domains', () => {
  function context() {
    return {
      domainsService: { listDomains: vi.fn().mockResolvedValue({ data: [] }) },
      ensureToolScopeForResource: vi.fn(),
    };
  }

  it('limits the list to domains the caller may view', async () => {
    const ctx = context();

    await executeDomainTool(
      ctx as never,
      { id: 'user-1', scopes: ['domains:view:domain-1'] } as never,
      'list_domains',
      {}
    );

    expect(ctx.domainsService.listDomains).toHaveBeenCalledWith(expect.any(Object), { allowedIds: ['domain-1'] });
  });

  it('does not restrict a caller with global domain view', async () => {
    const ctx = context();

    await executeDomainTool(ctx as never, { id: 'user-1', scopes: ['domains:view'] } as never, 'list_domains', {});

    expect(ctx.domainsService.listDomains).toHaveBeenCalledWith(expect.any(Object), { allowedIds: undefined });
  });
});
