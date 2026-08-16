import { describe, expect, it, vi } from 'vitest';
import { assertRegisteredDomainsUseNode, getRegisteredDomainCandidates } from './proxy-domain-node.js';

function databaseWithDomains(rows: Array<{ domain: string; nginxNodeId: string | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  return {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    where,
  };
}

describe('proxy host registered domain node assignment', () => {
  it('queries both exact and wildcard registrations case-insensitively', () => {
    expect(getRegisteredDomainCandidates([' APP.Example.com ', '*.API.Example.com'])).toEqual([
      'app.example.com',
      '*.app.example.com',
      '*.example.com',
      'api.example.com',
      '*.api.example.com',
    ]);
  });

  it('allows unregistered domains and domains assigned to the proxy Nginx node', async () => {
    const empty = databaseWithDomains([]);
    await expect(
      assertRegisteredDomainsUseNode(empty as never, ['unregistered.example.com'], 'node-1')
    ).resolves.toBeUndefined();

    const matching = databaseWithDomains([{ domain: 'app.example.com', nginxNodeId: 'node-1' }]);
    await expect(
      assertRegisteredDomainsUseNode(matching as never, ['APP.EXAMPLE.COM'], 'node-1')
    ).resolves.toBeUndefined();
  });

  it('rejects a registered domain assigned to another or unresolved Nginx node', async () => {
    const mismatched = databaseWithDomains([{ domain: 'app.example.com', nginxNodeId: 'node-2' }]);
    await expect(
      assertRegisteredDomainsUseNode(mismatched as never, ['app.example.com'], 'node-1')
    ).rejects.toMatchObject({ code: 'DOMAIN_NGINX_NODE_MISMATCH', statusCode: 409 });

    const unresolved = databaseWithDomains([{ domain: 'app.example.com', nginxNodeId: null }]);
    await expect(
      assertRegisteredDomainsUseNode(unresolved as never, ['app.example.com'], 'node-1')
    ).rejects.toMatchObject({ code: 'DOMAIN_NGINX_NODE_MISMATCH', statusCode: 409 });
  });

  it('applies the registered base-domain assignment to wildcard proxy hosts', async () => {
    const matching = databaseWithDomains([{ domain: 'example.com', nginxNodeId: 'node-1' }]);
    await expect(
      assertRegisteredDomainsUseNode(matching as never, ['*.EXAMPLE.COM'], 'node-1')
    ).resolves.toBeUndefined();

    const mismatched = databaseWithDomains([{ domain: 'example.com', nginxNodeId: 'node-2' }]);
    await expect(
      assertRegisteredDomainsUseNode(mismatched as never, ['*.example.com'], 'node-1')
    ).rejects.toMatchObject({ code: 'DOMAIN_NGINX_NODE_MISMATCH', statusCode: 409 });
  });

  it('applies a registered parent wildcard assignment to an exact subdomain proxy host', async () => {
    const mismatched = databaseWithDomains([{ domain: '*.example.com', nginxNodeId: 'node-2' }]);
    await expect(
      assertRegisteredDomainsUseNode(mismatched as never, ['API.EXAMPLE.COM'], 'node-1')
    ).rejects.toMatchObject({
      code: 'DOMAIN_NGINX_NODE_MISMATCH',
      statusCode: 409,
    });
  });
});
