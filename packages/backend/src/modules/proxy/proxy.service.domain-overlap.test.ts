import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/created-resource-permissions.js', () => ({
  grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
}));

import { domains, nodes, proxyHosts } from '@/db/schema/index.js';
import { CreateProxyHostSchema } from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type HostRow = { id: string; nodeId: string; enabled: boolean; domainNames: string[] } & Record<string, unknown>;

/**
 * Proxy host table in memory. Every statement yields first, so two creates
 * interleave between the domain check and the insert unless the node lock
 * serializes them.
 */
function createHostDb(requestedDomains: () => string[]) {
  const hosts: HostRow[] = [];
  let nextId = 1;
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const run = async () => {
        await Promise.resolve();
        if (table === nodes) return [{ id: NODE_ID, type: 'nginx', serviceCreationLocked: false }];
        if (table === domains) return [];
        if (table === proxyHosts) {
          const requested = requestedDomains().map((domain) => domain.toLowerCase());
          return hosts
            .filter((host) => host.nodeId === NODE_ID && host.enabled)
            .filter((host) => host.domainNames.some((domain) => requested.includes(domain.toLowerCase())))
            .map((host) => ({ id: host.id, domainNames: host.domainNames }));
        }
        return [];
      };
      const query = {
        where: () => query,
        limit: () => run(),
        // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          run().then(resolve, reject),
      };
      return query;
    },
  }));
  const insertValues = vi.fn((values: Record<string, unknown>) => ({
    returning: async () => {
      await Promise.resolve();
      const row = {
        ...values,
        id: `host-${nextId++}`,
        enabled: true,
        upstreamKind: 'manual',
        dockerDeploymentId: null,
        dockerNodeId: null,
      } as unknown as HostRow;
      hosts.push(row);
      return [row];
    },
  }));
  const db = { select, insert: vi.fn(() => ({ values: insertValues })) };
  return { db, hosts, insertValues };
}

describe('ProxyService domain overlap per node', () => {
  // Regression (rc10 audit F4): a double-submitted or retried create inserted
  // two enabled hosts for one server_name on one node.
  it('lets only one of two concurrent creates for the same domain on a node commit', async () => {
    const domainNames = ['app.example.com'];
    const { db, hosts, insertValues } = createHostDb(() => domainNames);
    const service = new ProxyService(db as never, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);
    vi.spyOn(service as any, 'buildNginxConfig').mockResolvedValue('server {}');
    vi.spyOn(service as any, 'applyConfigToNode').mockResolvedValue(undefined);
    const input = CreateProxyHostSchema.parse({
      type: 'proxy',
      nodeId: NODE_ID,
      domainNames,
      upstreamKind: 'manual',
      forwardHost: 'upstream.internal',
      forwardPort: 8080,
    });

    const results = await Promise.allSettled([
      service.createProxyHost(input, USER_ID),
      service.createProxyHost({ ...input, domainNames: ['APP.example.com'] }, USER_ID),
    ]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { statusCode: 409, code: 'PROXY_HOST_DOMAIN_CONFLICT', details: { proxyHostId: 'host-1' } },
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(hosts).toHaveLength(1);
  });

  it('reports a certificate deleted during the host write as a conflict, not a server error', async () => {
    const { db } = createHostDb(() => []);
    const fkViolation = Object.assign(new Error('insert or update on table "proxy_hosts" violates foreign key'), {
      code: '23503',
      constraint: 'proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk',
    });
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.reject(fkViolation) }) }));
    const service = new ProxyService(db as never, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);
    const input = CreateProxyHostSchema.parse({
      type: 'proxy',
      nodeId: NODE_ID,
      domainNames: ['secure.example.com'],
      upstreamKind: 'manual',
      forwardHost: 'upstream.internal',
      forwardPort: 8080,
      sslEnabled: true,
      sslCertificateId: '44444444-4444-4444-8444-444444444444',
    });

    await expect(service.createProxyHost(input, USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SSL_CERT_DELETED',
    });
  });
});

describe('ProxyService domain overlap on ingress migration moves', () => {
  const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

  // rc.11: skipDomainNodeValidation (the ingress migration's host moves)
  // skipped the overlap check too, so a move made the target serve one name
  // from two enabled hosts.
  it('refuses to move a host onto a node where an enabled host already serves its name', async () => {
    const hosts: HostRow[] = [
      { id: 'host-1', nodeId: NODE_ID, enabled: true, domainNames: ['app.example.com'] },
      {
        id: 'host-2',
        nodeId: SOURCE_ID,
        enabled: true,
        domainNames: ['App.example.com'],
        type: 'proxy',
        upstreamKind: 'manual',
        forwardHost: 'upstream.internal',
        forwardPort: 8080,
        forwardScheme: 'http',
        isSystem: false,
        maintenanceEnabled: false,
        rawConfigEnabled: false,
        relaySpreadMode: 'auto',
        relaySpreadCount: null,
        sslEnabled: false,
        secureLinkGeneration: 0,
      },
    ];
    const select = vi.fn(() => ({
      from: (table: unknown) => {
        const run = async () => {
          if (table === nodes) return [{ id: NODE_ID, type: 'nginx', serviceCreationLocked: false }];
          if (table === proxyHosts) {
            return hosts
              .filter((host) => host.nodeId === NODE_ID && host.enabled && host.id !== 'host-2')
              .map((host) => ({ id: host.id, domainNames: host.domainNames }));
          }
          return [];
        };
        const query = {
          where: () => query,
          limit: () => run(),
          // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            run().then(resolve, reject),
        };
        return query;
      },
    }));
    const update = vi.fn();
    const db = {
      select,
      update,
      query: { proxyHosts: { findFirst: vi.fn(async () => hosts[1]) } },
    };
    const service = new ProxyService(db as never, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);

    await expect(
      service.updateProxyHost('host-2', { nodeId: NODE_ID }, USER_ID, {
        skipDomainNodeValidation: true,
        preserveFormerNodeConfig: true,
        allowSystemNodeMove: true,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROXY_HOST_DOMAIN_CONFLICT',
      details: { proxyHostId: 'host-1', nodeId: NODE_ID, domains: ['app.example.com'] },
    });
    expect(update).not.toHaveBeenCalled();
  });
});
