import { describe, expect, it, vi } from 'vitest';
import type { HostingFirewallConfig } from '../hosting-firewall.types.js';
import type { HostingRequestOptions } from '../hosting-http.js';
import { HostingProviderError } from '../hosting-http.js';
import { type HostingResourceSnapshot, hostingCapabilities } from '../hosting-provider.types.js';
import { ProxmoxFirewallAdapter } from './proxmox-firewall.js';

const resource: HostingResourceSnapshot = {
  remoteId: '250',
  kind: 'vm',
  name: 'vm',
  location: 'pve',
  powerState: 'running',
  cpu: 1,
  memoryMb: 1024,
  diskGb: 25,
  addresses: [],
  incarnation: 'smbios:vm-250',
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
function body(options: unknown): Record<string, unknown> {
  if (
    !options ||
    typeof options !== 'object' ||
    !('body' in options) ||
    !options.body ||
    typeof options.body !== 'object'
  )
    throw new Error('Expected request body');
  return options.body as Record<string, unknown>;
}

function adapterFor(overrides: Record<string, unknown> = {}) {
  const state = {
    cluster: { enable: 1 },
    config: { net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' },
    options: { enable: 0, digest: 'options-digest' },
    vmRules: [] as unknown[],
    groups: [] as unknown[],
    groupRules: [] as unknown[],
    permissions: { '/': { 'Sys.Modify': 1 }, '/vms/250': { 'VM.Config.Network': 1 } },
    ...overrides,
  };
  const request = vi.fn(async (path: string, options?: HostingRequestOptions): Promise<unknown> => {
    if (options?.method) {
      const data = body(options);
      if (path === '/cluster/firewall/groups') state.groups.push({ group: data.group, comment: data.comment });
      else if (path.startsWith('/cluster/firewall/groups/')) state.groupRules.unshift(data);
      else if (path === '/nodes/pve/qemu/250/firewall/rules') state.vmRules.unshift(data);
      else if (path === '/nodes/pve/qemu/250/firewall/options') Object.assign(state.options, data);
      return null;
    }
    if (path === '/cluster/firewall/options') {
      if (state.cluster instanceof Error) throw state.cluster;
      return state.cluster;
    }
    if (path === '/nodes/pve/qemu/250/config') return state.config;
    if (path === '/nodes/pve/qemu/250/firewall/options') return { ...state.options };
    if (path === '/nodes/pve/qemu/250/firewall/rules') return [...state.vmRules];
    if (path === '/cluster/firewall/groups') return state.groups;
    if (path.startsWith('/cluster/firewall/groups/')) return state.groupRules;
    if (path === '/access/permissions') return state.permissions;
    return null;
  });
  const getResource = vi.fn(async () => resource);
  return { adapter: new ProxmoxFirewallAdapter({ request: request as never, getResource }), request };
}

describe('Proxmox firewall adapter', () => {
  it('uses an observed fingerprint independent of the proposed policy', async () => {
    const { adapter } = adapterFor();
    const first = await adapter.read(resource, 'owner-1', { ...desired, enabled: false, rules: [] });
    const second = await adapter.read(resource, 'owner-1', desired);
    expect(first.fingerprint).toBe(second.fingerprint);
  });
  it('does not temporarily disable active filtering while staging a replacement', async () => {
    const { adapter, request } = adapterFor();
    const first = await adapter.read(resource, 'owner-1', desired);
    await adapter.apply(resource, 'owner-1', desired, first);
    expect(request.mock.calls.some(([, options]) => options?.method === 'PUT' && body(options).enable === 0)).toBe(
      false
    );
    expect(request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  });
  it('splits IPv4 and IPv6 address lists and uses IPv6 ICMP explicitly', async () => {
    const { adapter, request } = adapterFor();
    const config = {
      ...desired,
      rules: [{ ...desired.rules[0]!, protocol: 'icmp' as const, ports: 'all', addresses: ['0.0.0.0/0', '::/0'] }],
    };
    const observed = await adapter.read(resource, 'owner-1', config);
    await adapter.apply(resource, 'owner-1', config, observed);
    const rules = request.mock.calls
      .filter(([path, options]) => path.startsWith('/cluster/firewall/groups/') && options?.method === 'POST')
      .map(([, options]) => body(options));
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proto: 'icmp', source: '0.0.0.0/0' }),
        expect.objectContaining({ proto: 'ipv6-icmp', source: '::/0' }),
      ])
    );
    expect(
      rules.every((rule) => !(String(rule.source).includes('0.0.0.0') && String(rule.source).includes('::')))
    ).toBe(true);
  });
  it('stages an owned group then binds it only to the selected VM with digest-protected writes', async () => {
    const { adapter, request } = adapterFor();
    const expected = await adapter.read(resource, 'owner-1', desired);
    await adapter.apply(resource, 'owner-1', desired, expected);
    const groupCreate = request.mock.calls.find(
      ([path, options]) => path === '/cluster/firewall/groups' && options?.method === 'POST'
    );
    expect(groupCreate?.[1]).toMatchObject({ body: { group: expect.stringMatching(/^gwfw[a-f0-9]{14}$/) } });
    const groupRules = request.mock.calls.filter(
      ([path, options]) => path.startsWith('/cluster/firewall/groups/gwfw') && options?.method === 'POST'
    );
    expect(groupRules.map(([, options]) => body(options).action).reverse()).toEqual([
      'DROP',
      'ACCEPT',
      'ACCEPT',
      'ACCEPT',
      'ACCEPT',
      'ACCEPT',
    ]);
    expect(
      groupRules.every(([, options]) => body(options).enable === 1 && typeof body(options).digest === 'string')
    ).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/nodes/pve/qemu/250/firewall/options',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          enable: 1,
          policy_in: 'DROP',
          policy_out: 'DROP',
          dhcp: 0,
          ndp: 0,
          radv: 1,
          digest: 'options-digest',
        }),
      })
    );
  });

  it('reports cluster and NIC prerequisites as blockers without mutating them', async () => {
    const { adapter, request } = adapterFor({
      cluster: { enable: 0 },
      config: { net0: 'virtio=AA:BB:CC,bridge=vmbr0' },
    });
    const expected = await adapter.read(resource, 'owner-1', desired);
    expect(expected.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cluster firewall is disabled'),
        expect.stringContaining('NIC must have firewall=1'),
      ])
    );
    await expect(adapter.apply(resource, 'owner-1', desired, expected)).rejects.toMatchObject({ providerStatus: 409 });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('returns the precise Sys.Audit blocker when cluster enablement cannot be read', async () => {
    const { adapter, request } = adapterFor({ cluster: new HostingProviderError(403, false, 'forbidden') });
    const observed = await adapter.read(resource, 'owner-1', desired);
    expect(observed.blockers).toEqual([
      'Proxmox token lacks Sys.Audit on / to read whether the cluster firewall is enabled; Gateway will not enable it.',
    ]);
    expect(request).toHaveBeenCalledWith('/cluster/firewall/options');
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('preserves an external active VM rule by blocking instead of overwriting it', async () => {
    const { adapter, request } = adapterFor({
      vmRules: [{ pos: 0, digest: 'vm-digest', type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22', enable: 1 }],
    });
    const expected = await adapter.read(resource, 'owner-1', desired);
    expect(expected.blockers).toContain('The VM has active firewall rules or groups not owned by Gateway.');
    await expect(adapter.apply(resource, 'owner-1', desired, expected)).rejects.toMatchObject({ providerStatus: 409 });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('treats disabled and detached state as ready while retaining a staged group', async () => {
    const disabled = { ...desired, enabled: false };
    const { adapter, request } = adapterFor({
      groups: [{ group: 'gwfw000000000000', comment: 'Gateway firewall 000000000000' }],
      groupRules: [{ pos: 0, digest: 'group-digest', type: 'in', action: 'ACCEPT', proto: 'tcp', enable: 1 }],
    });
    const expected = await adapter.read(resource, 'owner-1', disabled);
    expect(expected).toMatchObject({ enabled: false, matches: true });
    await adapter.apply(resource, 'owner-1', disabled, expected);
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
