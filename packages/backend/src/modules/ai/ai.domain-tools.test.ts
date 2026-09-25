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

describe('executeDomainTool manage_domain preview', () => {
  const NODE_1 = '11111111-1111-4111-8111-111111111111';
  const NODE_2 = '22222222-2222-4222-8222-222222222222';
  function context() {
    return {
      domainsService: { previewDomain: vi.fn().mockResolvedValue({ records: [] }) },
      ensureToolScopeForResource: vi.fn(),
    };
  }
  const preview = (ctx: ReturnType<typeof context>, scopes: string[], nginxNodeId?: string) =>
    executeDomainTool(ctx as never, { id: 'user-1', scopes } as never, 'manage_domain', {
      operation: 'preview',
      domain: 'app.example.com',
      ...(nginxNodeId ? { nginxNodeId } : {}),
    });

  it('keeps node-only creators on the nodes of their grant, like REST', async () => {
    const ctx = context();
    const scopes = [`domains:create:node/${NODE_1}`];

    await expect(preview(ctx, scopes, NODE_2)).rejects.toMatchObject({ statusCode: 403 });
    await expect(preview(ctx, scopes)).rejects.toMatchObject({ statusCode: 403 });
    expect(ctx.domainsService.previewDomain).not.toHaveBeenCalled();

    await expect(preview(ctx, scopes, NODE_1)).resolves.toEqual({ records: [] });
    expect(ctx.domainsService.previewDomain).toHaveBeenCalledOnce();
  });

  it('lets broad and folder creators preview on any node', async () => {
    const ctx = context();

    await expect(preview(ctx, ['domains:create'], NODE_2)).resolves.toEqual({ records: [] });
    await expect(preview(ctx, ['domains:create:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e'], NODE_2)).resolves.toEqual(
      { records: [] }
    );
  });
});
