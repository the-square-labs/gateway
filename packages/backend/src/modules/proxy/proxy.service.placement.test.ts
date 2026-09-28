import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  group: { group: { id: 'group-1' }, memberNodeIds: ['a', 'b'], activeNodeIds: ['a', 'b'], primaryNodeId: 'a' },
}));

vi.mock('@/modules/ingress-groups/ingress-group-routing.js', () => ({
  requireRoutableIngressGroup: vi.fn(async () => mocks.group),
}));
vi.mock('@/modules/nodes/service-creation-lock.js', () => ({
  assertNodeAllowsServiceCreation: vi.fn(async () => undefined),
}));
vi.mock('./proxy-domain-node.js', async (original) => ({
  ...(await original<typeof import('./proxy-domain-node.js')>()),
  assertRegisteredDomainsUseTarget: vi.fn(async () => undefined),
}));
vi.mock('./proxy-domain-overlap.js', async (original) => ({
  ...(await original<typeof import('./proxy-domain-overlap.js')>()),
  assertNoProxyDomainOverlapOnNodes: vi.fn(async () => undefined),
}));

import { ProxyService } from './proxy.service.js';
import { requestedPlacementChange } from './proxy.service.placement.js';

const existing = {
  id: 'host-1',
  nodeId: 'a',
  ingressGroupId: null,
  enabled: true,
  isSystem: false,
  upstreamKind: 'manual',
  domainNames: ['app.example.com'],
};

function service(events: string[]) {
  const updateChain: Record<string, any> = {};
  updateChain.set = vi.fn((values: Record<string, unknown>) => {
    events.push(`db:${values.ingressGroupId ?? 'node'}`);
    return updateChain;
  });
  updateChain.where = vi.fn(() => updateChain);
  updateChain.returning = vi.fn(async () => [{ ...existing, ingressGroupId: 'group-1' }]);
  updateChain.catch = vi.fn(() => updateChain);
  return Object.assign(Object.create(ProxyService.prototype), {
    db: {
      update: vi.fn(() => updateChain),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    },
    ingressNodesOf: vi.fn(async () => ['a']),
    secureLinks: { syncHostSources: vi.fn(async () => events.push('sources')) },
    additionalRoutes: { syncServingNodes: vi.fn(async () => undefined) },
    deliverHost: vi.fn(async () => events.push('deliver')),
    withdrawHost: vi.fn(async () => events.push('withdraw')),
    auditService: { log: vi.fn(async () => undefined) },
    emitHost: vi.fn(),
  });
}

describe('route placement between a node and an ingress group', () => {
  beforeEach(() => {
    mocks.group = {
      group: { id: 'group-1' },
      memberNodeIds: ['a', 'b'],
      activeNodeIds: ['a', 'b'],
      primaryNodeId: 'a',
    };
  });

  it('reads a placement change from an update request', () => {
    expect(requestedPlacementChange(existing, { ingressGroupId: 'group-1' })).toEqual({
      ingressGroupId: 'group-1',
      nodeId: null,
    });
    expect(
      requestedPlacementChange({ nodeId: 'a', ingressGroupId: 'group-1' }, { ingressGroupId: null, nodeId: 'b' })
    ).toEqual({ ingressGroupId: null, nodeId: 'b' });
    expect(requestedPlacementChange(existing, { nodeId: 'c' })).toBeNull();
    expect(() => requestedPlacementChange({ nodeId: 'a', ingressGroupId: 'group-1' }, { nodeId: 'b' })).toThrow(
      /ingress group/
    );
  });

  it('refuses a group that does not keep the serving node', async () => {
    mocks.group = {
      group: { id: 'group-1' },
      memberNodeIds: ['b', 'c'],
      activeNodeIds: ['b', 'c'],
      primaryNodeId: 'b',
    };
    const events: string[] = [];

    await expect(
      (service(events) as any).changeRoutePlacementLocked(
        existing,
        { ingressGroupId: 'group-1', nodeId: null },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'INGRESS_PLACEMENT_WOULD_INTERRUPT' });
    expect(events).toEqual([]);
  });

  it('prepares and delivers the route on the new members before anything is withdrawn', async () => {
    const events: string[] = [];

    await (service(events) as any).changeRoutePlacementLocked(
      existing,
      { ingressGroupId: 'group-1', nodeId: null },
      'user-1'
    );

    expect(events).toEqual(['db:group-1', 'sources', 'deliver']);
  });
});
