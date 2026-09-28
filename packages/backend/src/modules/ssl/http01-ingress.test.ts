import { describe, expect, it, vi } from 'vitest';
import { resolveHttp01Ingress } from './http01-ingress.js';

type NodeInput = {
  id: string;
  type: string;
  status: string;
  serviceAddress?: string | null;
  lastHealthReport?: { publicIpAddresses?: string[]; localIpAddresses?: string[] } | null;
};

function database(input: {
  registered?: { domain: string; nginxNodeId: string | null; ingressGroupId?: string | null } | null;
  legacyHosts?: Array<{ nodeId: string | null; ingressGroupId?: string | null }>;
  legacyNodeIds?: Array<string | null>;
  node?: NodeInput | null;
  nodes?: NodeInput[];
  members?: Array<{ groupId: string; nodeId: string; priority: number; state?: string }>;
}) {
  const nodes = [...(input.node ? [input.node] : []), ...(input.nodes ?? [])].map((node) => ({
    serviceAddress: null,
    lastHealthReport: { publicIpAddresses: ['8.8.8.8'] },
    ...node,
  }));
  const members = (input.members ?? []).map((member) => ({ state: 'active', ...member }));
  const orderBy = vi.fn().mockResolvedValue(members);
  return {
    query: {
      domains: { findFirst: vi.fn().mockResolvedValue(input.registered ?? null) },
      proxyHosts: {
        findMany: vi
          .fn()
          .mockResolvedValue(
            input.legacyHosts ?? (input.legacyNodeIds ?? []).map((nodeId) => ({ nodeId, ingressGroupId: null }))
          ),
      },
      nodes: { findMany: vi.fn().mockResolvedValue(nodes) },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy })) })) })),
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
      nodeIds: ['node-domain'],
      offlineNodeIds: [],
      ingressGroupId: null,
      source: 'domain',
    });
    expect(db.query.proxyHosts.findMany).not.toHaveBeenCalled();
  });

  it('publishes the token on every online member of an ingress group domain', async () => {
    const db = database({
      registered: { domain: 'app.example.com', nginxNodeId: 'node-a', ingressGroupId: 'group-1' },
      nodes: [
        { id: 'node-a', type: 'nginx', status: 'online' },
        { id: 'node-b', type: 'nginx', status: 'online', lastHealthReport: { localIpAddresses: ['10.0.0.5'] } },
        { id: 'node-c', type: 'nginx', status: 'offline' },
      ],
      members: [
        { groupId: 'group-1', nodeId: 'node-a', priority: 0 },
        { groupId: 'group-1', nodeId: 'node-b', priority: 1 },
        { groupId: 'group-1', nodeId: 'node-c', priority: 2 },
      ],
    });

    await expect(resolveHttp01Ingress(db, 'app.example.com')).resolves.toEqual({
      domain: 'app.example.com',
      nodeId: 'node-a',
      // A member without a detected public address still gets the token: DNS may reach it.
      nodeIds: ['node-a', 'node-b'],
      offlineNodeIds: ['node-c'],
      ingressGroupId: 'group-1',
      source: 'domain',
    });
  });

  it('rejects a group domain when no member is online', async () => {
    const db = database({
      registered: { domain: 'app.example.com', nginxNodeId: 'node-a', ingressGroupId: 'group-1' },
      nodes: [{ id: 'node-a', type: 'nginx', status: 'offline' }],
      members: [{ groupId: 'group-1', nodeId: 'node-a', priority: 0 }],
    });

    await expect(resolveHttp01Ingress(db, 'app.example.com')).rejects.toMatchObject({
      code: 'HTTP01_INGRESS_UNAVAILABLE',
    });
  });

  it('uses one existing Proxy Host node only as a legacy compatibility source', async () => {
    const db = database({
      legacyNodeIds: ['node-legacy', 'node-legacy'],
      node: { id: 'node-legacy', type: 'nginx', status: 'online' },
    });

    await expect(resolveHttp01Ingress(db, 'legacy.example.com')).resolves.toMatchObject({
      nodeId: 'node-legacy',
      nodeIds: ['node-legacy'],
      source: 'proxy_host',
    });
  });

  it('uses every member of an unregistered group route', async () => {
    const db = database({
      legacyHosts: [{ nodeId: 'node-a', ingressGroupId: 'group-1' }],
      nodes: [
        { id: 'node-a', type: 'nginx', status: 'online' },
        { id: 'node-b', type: 'nginx', status: 'online' },
      ],
      members: [
        { groupId: 'group-1', nodeId: 'node-a', priority: 0 },
        { groupId: 'group-1', nodeId: 'node-b', priority: 1 },
      ],
    });

    await expect(resolveHttp01Ingress(db, 'legacy.example.com')).resolves.toMatchObject({
      nodeIds: ['node-a', 'node-b'],
      ingressGroupId: 'group-1',
      source: 'proxy_host',
    });
  });

  it('rejects an unregistered domain instead of falling back to every online node', async () => {
    const db = database({ node: { id: 'unused', type: 'nginx', status: 'online' } });

    await expect(resolveHttp01Ingress(db, 'missing.example.com')).rejects.toMatchObject({
      code: 'HTTP01_DOMAIN_NOT_REGISTERED',
    });
    expect(db.query.nodes.findMany).not.toHaveBeenCalled();
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
