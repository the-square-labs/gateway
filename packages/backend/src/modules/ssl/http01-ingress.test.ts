import { describe, expect, it, vi } from 'vitest';
import { resolveHttp01Ingress } from './http01-ingress.js';

function database(input: {
  registered?: { domain: string; nginxNodeId: string | null } | null;
  legacyNodeIds?: Array<string | null>;
  node?: {
    id: string;
    type: string;
    status: string;
    serviceAddress?: string | null;
    lastHealthReport?: { publicIpAddresses?: string[]; localIpAddresses?: string[] } | null;
  } | null;
}) {
  const node = input.node
    ? {
        serviceAddress: null,
        lastHealthReport: { publicIpAddresses: ['8.8.8.8'] },
        ...input.node,
      }
    : null;
  return {
    query: {
      domains: { findFirst: vi.fn().mockResolvedValue(input.registered ?? null) },
      proxyHosts: {
        findMany: vi.fn().mockResolvedValue((input.legacyNodeIds ?? []).map((nodeId) => ({ nodeId }))),
      },
      nodes: { findFirst: vi.fn().mockResolvedValue(node) },
    },
  } as any;
}

describe('resolveHttp01Ingress', () => {
  it('uses the registered Domain Nginx assignment as the authoritative ingress', async () => {
    const db = database({
      registered: { domain: 'app.example.com', nginxNodeId: 'node-domain' },
      legacyNodeIds: ['node-legacy'],
      node: { id: 'node-domain', type: 'nginx', status: 'online' },
    });

    await expect(resolveHttp01Ingress(db, 'APP.EXAMPLE.COM')).resolves.toEqual({
      domain: 'app.example.com',
      nodeId: 'node-domain',
      source: 'domain',
    });
    expect(db.query.proxyHosts.findMany).not.toHaveBeenCalled();
  });

  it('uses one existing Proxy Host node only as a legacy compatibility source', async () => {
    const db = database({
      legacyNodeIds: ['node-legacy', 'node-legacy'],
      node: { id: 'node-legacy', type: 'nginx', status: 'online' },
    });

    await expect(resolveHttp01Ingress(db, 'legacy.example.com')).resolves.toMatchObject({
      nodeId: 'node-legacy',
      source: 'proxy_host',
    });
  });

  it('rejects an unregistered domain instead of falling back to every online node', async () => {
    const db = database({ node: { id: 'unused', type: 'nginx', status: 'online' } });

    await expect(resolveHttp01Ingress(db, 'missing.example.com')).rejects.toMatchObject({
      code: 'HTTP01_DOMAIN_NOT_REGISTERED',
    });
    expect(db.query.nodes.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a registered domain without an ingress assignment', async () => {
    const db = database({ registered: { domain: 'app.example.com', nginxNodeId: null } });

    await expect(resolveHttp01Ingress(db, 'app.example.com')).rejects.toMatchObject({
      code: 'HTTP01_INGRESS_UNASSIGNED',
    });
    expect(db.query.proxyHosts.findMany).not.toHaveBeenCalled();
  });

  it('rejects ambiguous legacy placement', async () => {
    const db = database({ legacyNodeIds: ['node-a', 'node-b'] });

    await expect(resolveHttp01Ingress(db, 'legacy.example.com')).rejects.toMatchObject({
      code: 'HTTP01_INGRESS_AMBIGUOUS',
    });
  });

  it('rejects an unavailable assigned ingress', async () => {
    const db = database({
      registered: { domain: 'app.example.com', nginxNodeId: 'node-offline' },
      node: { id: 'node-offline', type: 'nginx', status: 'offline' },
    });

    await expect(resolveHttp01Ingress(db, 'app.example.com')).rejects.toMatchObject({
      code: 'HTTP01_INGRESS_UNAVAILABLE',
    });
  });

  it('rejects an assigned ingress without a detected public service address', async () => {
    const db = database({
      registered: { domain: 'app.example.com', nginxNodeId: 'node-private' },
      node: {
        id: 'node-private',
        type: 'nginx',
        status: 'online',
        lastHealthReport: { localIpAddresses: ['10.0.0.5'] },
      },
    });

    await expect(resolveHttp01Ingress(db, 'app.example.com')).rejects.toMatchObject({
      code: 'HTTP01_INGRESS_ADDRESS_REQUIRED',
    });
  });

  it('rejects wildcard HTTP-01 before querying ingress state', async () => {
    const db = database({});

    await expect(resolveHttp01Ingress(db, '*.example.com')).rejects.toMatchObject({
      code: 'HTTP01_WILDCARD_UNSUPPORTED',
    });
    expect(db.query.domains.findFirst).not.toHaveBeenCalled();
  });
});
