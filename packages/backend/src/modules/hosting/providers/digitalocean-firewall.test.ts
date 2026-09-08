import { describe, expect, it, vi } from 'vitest';
import type { HostingFirewallConfig } from '../hosting-firewall.types.js';
import type { HostingRequestOptions } from '../hosting-http.js';
import { HostingProviderError } from '../hosting-http.js';
import { type HostingResourceSnapshot, hostingCapabilities } from '../hosting-provider.types.js';
import { DigitalOceanFirewallAdapter } from './digitalocean-firewall.js';

const resource: HostingResourceSnapshot = {
  remoteId: '123',
  kind: 'vm',
  name: 'vm',
  location: 'nyc1',
  powerState: 'running',
  cpu: 1,
  memoryMb: 1024,
  diskGb: 25,
  addresses: [],
  incarnation: '2026-09-06T00:00:00Z',
  capabilities: hostingCapabilities({}),
  observedAt: '2026-09-06T00:00:00Z',
};
const desired: HostingFirewallConfig = {
  enabled: true,
  inboundPolicy: 'allow',
  outboundPolicy: 'deny',
  rules: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      direction: 'in',
      action: 'allow',
      protocol: 'tcp',
      ports: '443',
      addresses: ['203.0.113.0/24'],
      description: 'https',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      direction: 'in',
      action: 'deny',
      protocol: 'tcp',
      ports: '443',
      addresses: ['203.0.113.66'],
      description: 'blocked',
    },
  ],
};

function adapterFor(firewalls: unknown[], attached: unknown[] = []) {
  const request = vi.fn(async (path: string, _options?: HostingRequestOptions): Promise<unknown> => {
    if (path === '/v2/firewalls') return { firewalls };
    if (path === '/v2/droplets/123/firewalls') return { firewalls: attached };
    return {};
  });
  const getResource = vi.fn(async () => resource);
  return { adapter: new DigitalOceanFirewallAdapter({ request: request as never, getResource }), request, getResource };
}

describe('DigitalOcean firewall adapter', () => {
  function cleanupTarget(overrides: Record<string, unknown> = {}) {
    const firewall = {
      id: 'fw-1',
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [],
      tags: [],
      pending_changes: [],
      status: 'succeeded',
      inbound_rules: [],
      outbound_rules: [],
      ...overrides,
    };
    const request = vi.fn(
      async (path: string, options?: HostingRequestOptions): Promise<unknown> =>
        options?.method === 'DELETE' ? undefined : path === '/v2/firewalls' ? { firewalls: [firewall] } : { firewall }
    );
    const getResource = vi.fn<() => Promise<HostingResourceSnapshot | null>>().mockResolvedValue(null);
    const adapter = new DigitalOceanFirewallAdapter({ request: request as never, getResource });
    const checkpoint = vi.fn(async (_id: string) => {});
    return { adapter, request, getResource, checkpoint, firewall };
  }
  it('deletes only the exact detached owned firewall after persisting its dispatch fence', async () => {
    const test = cleanupTarget();
    test.checkpoint.mockImplementation(async (id) => {
      expect(id).toBe('fw-1');
      expect(test.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    });
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).resolves.toEqual({
      status: 'deleted',
      remoteId: 'fw-1',
    });
    expect(test.request).toHaveBeenLastCalledWith('/v2/firewalls/fw-1', { method: 'DELETE' });
    expect(test.getResource).toHaveBeenCalledTimes(2);
    expect(test.checkpoint).toHaveBeenCalledTimes(1);
  });
  it.each([
    { tags: ['shared'] },
    { droplet_ids: [999] },
    { droplet_ids: [123] },
    { name: 'foreign' },
  ])('preserves an attached or renamed policy: %j', async (overrides) => {
    const test = cleanupTarget(overrides);
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).resolves.toMatchObject({
      status: 'preserved',
    });
    expect(test.checkpoint).not.toHaveBeenCalled();
    expect(test.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it.each([
    'droplet_ids',
    'tags',
    'pending_changes',
  ])('rejects incomplete %s evidence before deletion', async (field) => {
    const test = cleanupTarget({ [field]: undefined });
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).rejects.toThrow('unsafe');
    expect(test.checkpoint).not.toHaveBeenCalled();
  });
  it('does not delete when the exact VM exists again', async () => {
    const test = cleanupTarget();
    test.getResource.mockResolvedValue(resource);
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).rejects.toThrow(
      'VM still exists'
    );
    expect(test.request).not.toHaveBeenCalled();
  });
  it('rechecks sharing after the dispatch checkpoint', async () => {
    const test = cleanupTarget();
    test.checkpoint.mockImplementation(async () => {
      test.firewall.tags = ['external'] as never;
    });
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).resolves.toMatchObject({
      status: 'preserved',
    });
    expect(test.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('reconciles a lost deletion response without issuing a second DELETE', async () => {
    const test = cleanupTarget();
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', true, test.checkpoint)).rejects.toThrow(
      'will not be repeated'
    );
    expect(test.checkpoint).not.toHaveBeenCalled();
    test.request.mockRejectedValue(new HostingProviderError(404, false, 'not found'));
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', true, test.checkpoint)).resolves.toEqual({
      status: 'absent',
      remoteId: 'fw-1',
    });
    expect(test.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('waits for pending provider changes and preserves ambiguous ownership', async () => {
    const test = cleanupTarget({ pending_changes: [{ status: 'waiting' }] });
    await expect(test.adapter.cleanup(resource, 'owner-1', 'fw-1', false, test.checkpoint)).rejects.toThrow('waiting');
    test.request.mockResolvedValue({ firewalls: [test.firewall, { ...test.firewall, id: 'fw-2' }] });
    await expect(test.adapter.cleanup(resource, 'owner-1', null, false, test.checkpoint)).rejects.toThrow(
      'Several firewalls'
    );
    expect(test.checkpoint).not.toHaveBeenCalled();
  });
  it.each([
    'tags',
    'droplet_ids',
    'load_balancer_uids',
    'kubernetes_ids',
  ])('fingerprints and blocks unsupported %s selectors in both directions', async (selector) => {
    for (const direction of ['in', 'out'] as const) {
      const config = { ...desired, inboundPolicy: 'deny' as const, rules: [{ ...desired.rules[0]!, direction }] };
      const endpoint: Record<string, unknown> = { addresses: ['203.0.113.0/24'] };
      const remoteRule = { protocol: 'tcp', ports: '443', [direction === 'in' ? 'sources' : 'destinations']: endpoint };
      const owned = {
        id: '7',
        name: 'gateway-fw-e2fcc64045facd8bee7b',
        droplet_ids: [123],
        tags: [],
        inbound_rules: direction === 'in' ? [remoteRule] : [],
        outbound_rules: direction === 'out' ? [remoteRule] : [],
      };
      const { adapter, request } = adapterFor([owned], [owned]);
      const before = await adapter.read(resource, 'owner-1', config);
      expect(before.matches).toBe(true);
      endpoint[selector] = selector === 'droplet_ids' ? [999] : ['external'];
      const after = await adapter.read(resource, 'owner-1', config);
      expect(after.matches).toBe(false);
      expect(after.fingerprint).not.toBe(before.fingerprint);
      expect(after.blockers).toEqual([expect.stringContaining('unsupported')]);
      await expect(adapter.apply(resource, 'owner-1', config, after)).rejects.toMatchObject({ providerStatus: 409 });
      expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    }
  });
  it('permits an off policy without create/update scopes and never dispatches', async () => {
    const request = vi.fn(async () => ({ firewalls: [] }));
    const adapter = new DigitalOceanFirewallAdapter({
      request: request as never,
      getResource: async () => resource,
      scopes: async () => new Set(['firewall:read']),
    });
    const config = { ...desired, enabled: false };
    const observation = await adapter.read(resource, 'owner-1', config);
    expect(observation.blockers).not.toHaveLength(0);
    expect(observation.disableBlockers).toEqual([]);
    expect(observation.matches).toBe(true);
    await adapter.apply(resource, 'owner-1', config, observation);
    expect(request.mock.calls.length).toBeGreaterThan(2);
  });
  it('refuses writes while DigitalOcean is still applying a policy', async () => {
    const owned = {
      id: '7',
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [123],
      tags: [],
      status: 'waiting',
      inbound_rules: [],
      outbound_rules: [],
    };
    const { adapter, request } = adapterFor([owned], [owned]);
    const observed = await adapter.read(resource, 'owner-1', desired);
    await expect(adapter.apply(resource, 'owner-1', desired, observed)).rejects.toThrow('Wait for DigitalOcean');
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('uses an observed fingerprint independent of the proposed policy', async () => {
    const { adapter } = adapterFor([]);
    expect((await adapter.read(resource, 'owner-1', { ...desired, enabled: false, rules: [] })).fingerprint).toBe(
      (await adapter.read(resource, 'owner-1', desired)).fingerprint
    );
  });
  it('normalizes legacy action and all-port responses and updates before attaching', async () => {
    const owned = {
      id: '7',
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [],
      tags: [],
      status: 'succeeded',
      inbound_rules: [{ protocol: 'tcp', ports: '0', sources: { addresses: ['0.0.0.0/0'] } }],
      outbound_rules: [],
    };
    const { adapter, request } = adapterFor([owned]);
    const first = await adapter.read(resource, 'owner-1', desired);
    await adapter.apply(resource, 'owner-1', desired, first);
    const writes = request.mock.calls.filter(([, options]) => options?.method);
    expect(writes.map(([, options]) => options?.method)).toEqual(['PUT', 'POST']);
    expect(writes[0]![1]).toMatchObject({ body: { name: owned.name, droplet_ids: [], tags: [] } });
    expect(writes[1]![1]).toMatchObject({ body: { droplet_ids: [123] } });
  });
  it('ignores unrelated account policy syntax but blocks policies attached through tags', async () => {
    const foreign = {
      id: 'foreign',
      name: 'foreign',
      droplet_ids: [],
      tags: ['prod'],
      inbound_rules: [{ protocol: 'all', action: 'deny', sources: { droplet_ids: [4] } }],
    };
    const { adapter } = adapterFor([foreign]);
    expect((await adapter.read(resource, 'owner-1', desired)).blockers).toEqual([]);
    const attached = adapterFor([foreign], [foreign]);
    expect((await attached.adapter.read(resource, 'owner-1', desired)).blockers[0]).toContain('foreign');
  });
  it('stages a deterministic single-droplet firewall with deny rules before allow rules', async () => {
    const { adapter, request } = adapterFor([]);
    const expected = await adapter.read(resource, 'owner-1', desired);
    await adapter.apply(resource, 'owner-1', desired, expected);
    const create = request.mock.calls.find(([path, options]) => path === '/v2/firewalls' && options?.method === 'POST');
    expect(create?.[1]).toMatchObject({
      body: { droplet_ids: [123], tags: [], inbound_rules: expect.any(Array), outbound_rules: [] },
    });
    const inbound = (create?.[1] as { body: { inbound_rules: Array<{ action: string }> } }).body.inbound_rules;
    expect(inbound.map((rule) => rule.action)).toEqual(['deny', 'allow', 'allow', 'allow', 'allow']);
    expect(inbound.at(-1)).toMatchObject({ protocol: 'icmp', sources: { addresses: ['0.0.0.0/0', '::/0'] } });
  });

  it('blocks a droplet already affected by another policy, including tag-based policies', async () => {
    const other = {
      id: 9,
      name: 'shared-prod',
      droplet_ids: [],
      tags: ['production'],
      inbound_rules: [],
      outbound_rules: [],
    };
    const { adapter, request } = adapterFor([other], [other]);
    const expected = await adapter.read(resource, 'owner-1', desired);
    expect(expected.blockers).toEqual([expect.stringContaining('shared-prod')]);
    await expect(adapter.apply(resource, 'owner-1', desired, expected)).rejects.toMatchObject({ providerStatus: 409 });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('treats an owned detached firewall as disabled regardless of preserved staged rules', async () => {
    const staged = {
      id: 7,
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [],
      tags: [],
      inbound_rules: [{ action: 'allow', protocol: 'tcp', ports: '22', sources: { addresses: ['10.0.0.0/8'] } }],
      outbound_rules: [],
    };
    const disabled = { ...desired, enabled: false };
    const { adapter, request } = adapterFor([staged]);
    const expected = await adapter.read(resource, 'owner-1', disabled);
    expect(expected).toMatchObject({ enabled: false, matches: true, remoteId: '7' });
    await adapter.apply(resource, 'owner-1', disabled, expected);
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('revalidates an old off observation instead of silently ignoring a newly attached policy', async () => {
    const owned = {
      id: '7',
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [] as number[],
      tags: [],
      inbound_rules: [],
      outbound_rules: [],
    };
    const attached: unknown[] = [];
    const { adapter, request } = adapterFor([owned], attached);
    const disabled = { ...desired, enabled: false };
    const before = await adapter.read(resource, 'owner-1', disabled);
    owned.droplet_ids.push(123);
    attached.push(owned);
    await expect(adapter.apply(resource, 'owner-1', disabled, before)).rejects.toThrow('changed');
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('detaches only Gateway policy when a separate policy also affects the droplet', async () => {
    const owned = {
      id: '7',
      name: 'gateway-fw-e2fcc64045facd8bee7b',
      droplet_ids: [123],
      tags: [],
      inbound_rules: [],
      outbound_rules: [],
    };
    const foreign = { id: '8', name: 'foreign', droplet_ids: [123], tags: [], inbound_rules: [], outbound_rules: [] };
    const attached = [owned, foreign];
    const { adapter, request } = adapterFor([owned, foreign], attached);
    const disabled = { ...desired, enabled: false };
    const observation = await adapter.read(resource, 'owner-1', disabled);
    expect(observation.blockers).toEqual([expect.stringContaining('foreign')]);
    expect(observation.disableBlockers).toEqual([]);
    await adapter.apply(resource, 'owner-1', disabled, observation);
    expect(request.mock.calls.filter(([, options]) => options?.method)).toEqual([
      ['/v2/firewalls/7/droplets', { method: 'DELETE', body: { droplet_ids: [123] } }],
    ]);
    owned.droplet_ids = [];
    attached.shift();
    expect((await adapter.read(resource, 'owner-1', disabled)).matches).toBe(true);
  });
});
