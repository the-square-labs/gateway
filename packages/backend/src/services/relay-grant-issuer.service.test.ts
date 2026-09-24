import { describe, expect, it, vi } from 'vitest';
import { RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import { PROXY_RELAY_MAX_CONCURRENT_SESSIONS } from './relay-session-limits.js';

function issuer() {
  const service = new RelayGrantIssuerService({} as never, {} as never, {} as never) as any;
  service.nodeSupportsPool = vi.fn().mockResolvedValue(true);
  service.endpointPathSupportsPool = vi.fn().mockResolvedValue(true);
  service.signGrant = vi.fn(async (claims: unknown) => ({
    keyId: 'grant',
    payload: claims,
    signature: Buffer.alloc(0),
  }));
  return service;
}

const assignment = {
  endpointId: 'endpoint',
  generation: 3,
  state: 'active',
  role: 'active',
  instanceState: 'ready',
  poolId: 'system',
  instanceId: 'relay-1',
  kind: 'remote',
  addresses: ['relay.example'],
  port: 9443,
  certificateIdentity: 'relay-relay-1',
  certificateFingerprint: 'sha256:relay',
  capabilities: { features: ['relay_pool_v1'] },
};

describe('RelayGrantIssuerService candidate grants', () => {
  it('carries the same effective session limits as the policy for proxy Secure Links', async () => {
    const service = issuer();
    const endpoint = {
      id: 'endpoint',
      generation: 1,
      subjectKind: 'daemon',
      ownerKind: 'proxy_host_secure_link',
      maxConcurrentSessions: 256,
    };
    const route = {
      id: 'route',
      generation: 1,
      sourceKind: 'daemon',
      ownerKind: 'proxy_host_secure_link',
      maxConcurrentSessions: 16,
      maxFrameBytes: 1024 * 1024,
    };
    await service.issueCandidates([assignment], 'connect', 'node', 'sha256:node', endpoint, route, true);
    await service.issueCandidates([assignment], 'endpoint', 'node', 'sha256:node', endpoint, undefined, true);
    const [[connect], [register]] = service.signGrant.mock.calls;
    // The relay enforces the lower of policy and grant; 16 would cap every proxied route.
    expect(connect.maxConcurrentSessions).toBe(PROXY_RELAY_MAX_CONCURRENT_SESSIONS);
    expect(register.maxConcurrentSessions).toBe(PROXY_RELAY_MAX_CONCURRENT_SESSIONS);
  });

  it('keeps configured limits for database routes', async () => {
    const service = issuer();
    const endpoint = {
      id: 'endpoint',
      generation: 1,
      subjectKind: 'daemon',
      ownerKind: 'managed_database',
      maxConcurrentSessions: 64,
    };
    const route = {
      id: 'route',
      generation: 1,
      sourceKind: 'daemon',
      ownerKind: 'managed_database_binding',
      maxConcurrentSessions: 16,
      maxFrameBytes: 1024 * 1024,
    };
    await service.issueCandidates([assignment], 'connect', 'node', 'sha256:node', endpoint, route, true);
    expect(service.signGrant.mock.calls[0][0].maxConcurrentSessions).toBe(16);
  });
});

describe('RelayGrantIssuerService pool capability of endpoint paths', () => {
  it('flags endpoints whose target or any daemon source lacks pool support', async () => {
    const results = [
      [
        { id: 'capable', nodeId: 'target-a', subjectKind: 'daemon' },
        { id: 'old-source', nodeId: 'target-a', subjectKind: 'daemon' },
        { id: 'registry', nodeId: 'gateway-internal-registry', subjectKind: 'local_service' },
      ],
      [
        { endpointId: 'capable', sourceKind: 'daemon', sourceId: 'source-new' },
        { endpointId: 'capable', sourceKind: 'gateway', sourceId: 'gateway' },
        { endpointId: 'old-source', sourceKind: 'daemon', sourceId: 'source-old' },
        { endpointId: 'registry', sourceKind: 'daemon', sourceId: 'source-new' },
      ],
      [
        { id: 'target-a', capabilities: { capabilities: ['relay_pool_v1'] } },
        { id: 'source-new', capabilities: { capabilities: ['relay_pool_v1'] } },
        { id: 'source-old', capabilities: { capabilities: [] } },
      ],
    ];
    const db = {
      select: () => {
        const query: any = Promise.resolve(results.shift());
        for (const method of ['from', 'where']) query[method] = () => query;
        return query;
      },
    };
    const service = new RelayGrantIssuerService(db as never, {} as never, {} as never);
    await expect(service.poolIncapableEndpointIds(['capable', 'old-source', 'registry'])).resolves.toEqual(
      new Set(['old-source'])
    );
  });
});
