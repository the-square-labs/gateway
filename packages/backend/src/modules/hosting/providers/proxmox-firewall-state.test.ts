import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HostingFirewallConfig } from '../hosting-firewall.types.js';
import type { HostingRequestOptions } from '../hosting-http.js';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';
import { ProxmoxFirewallAdapter } from './proxmox-firewall.js';

const resource = { remoteId: '250', kind: 'vm', location: 'pve', incarnation: 'vm-250' } as HostingResourceSnapshot;
const desired: HostingFirewallConfig = {
  enabled: true,
  inboundPolicy: 'deny',
  outboundPolicy: 'allow',
  rules: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      action: 'deny',
      direction: 'out',
      protocol: 'udp',
      ports: '67-68',
      addresses: ['0.0.0.0/0'],
      description: 'Explicit DHCP deny',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      action: 'deny',
      direction: 'in',
      protocol: 'icmp',
      ports: 'all',
      addresses: ['::/0'],
      description: 'Explicit IPv6 ICMP deny',
    },
  ],
};
type Rule = Record<string, string | number | undefined>;

/** Stateful provider fake: writes change subsequent reads, positional rules and digests. */
function fixture() {
  const state = {
    cluster: { enable: 1 },
    config: { net0: 'virtio=AA,firewall=1', net1: 'virtio=BB,firewall=1' },
    options: { enable: 0, dhcp: 1, ndp: 1, radv: 0 } as Record<string, string | number>,
    rules: [] as Rule[],
    groups: new Map<string, { comment: string; rules: Rule[] }>(),
    rootPrivilege: true,
    vmPrivilege: true,
    beforeRequest: null as ((path: string, options: HostingRequestOptions) => void) | null,
  };
  const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const request = vi.fn(async (path: string, options: HostingRequestOptions = {}): Promise<unknown> => {
    state.beforeRequest?.(path, options);
    const body = { ...(options.body ?? {}) } as Record<string, string | number>;
    const method = options.method ?? 'GET';
    if (path === '/cluster/firewall/options') return { ...state.cluster };
    if (path.endsWith('/config')) return { ...state.config };
    if (path === '/access/permissions')
      return {
        '/': state.rootPrivilege ? { 'Sys.Modify': 0 } : {},
        '/vms/250': state.vmPrivilege ? { 'VM.Config.Network': 0 } : {},
      };
    if (path.endsWith('/firewall/options')) {
      if (method === 'PUT') {
        expect(body.digest).toBe(hash(state.options));
        delete body.digest;
        Object.assign(state.options, body);
        return null;
      }
      return { ...state.options, digest: hash(state.options) };
    }
    if (path === '/cluster/firewall/groups') {
      if (method === 'POST') {
        expect(String(body.group).length).toBeLessThanOrEqual(18);
        if (state.groups.has(String(body.group))) throw new Error('duplicate group');
        state.groups.set(String(body.group), { comment: String(body.comment), rules: [] });
        return null;
      }
      return [...state.groups].map(([group, data]) => ({ group, comment: data.comment }));
    }
    const group = path.match(/^\/cluster\/firewall\/groups\/([^/]+)$/)?.[1];
    const vm = path.match(/\/firewall\/rules(?:\/(\d+))?$/);
    const rules = group ? state.groups.get(group)!.rules : vm ? state.rules : null;
    if (!rules) throw new Error(`Unexpected ${method} ${path}`);
    if (method === 'GET') return rules.map((rule, pos) => ({ ...rule, pos, digest: hash(rules) }));
    if (method !== 'POST') expect(body.digest).toBe(hash(rules));
    delete body.digest;
    delete body.pos;
    if (method === 'POST')
      rules.unshift(body); // PVE prepends; POST does not assert digest.
    else if (method === 'PUT') Object.assign(rules[Number(vm?.[1])]!, body);
    else if (method === 'DELETE') rules.splice(Number(vm?.[1]), 1);
    else throw new Error(`Unexpected method ${method}`);
    return null;
  });
  const adapter = new ProxmoxFirewallAdapter({ request: request as never, getResource: async () => resource });
  const read = (config = desired) => adapter.read(resource, 'owner', config);
  const apply = async (config = desired) => adapter.apply(resource, 'owner', config, await read(config));
  return { state, request, read, apply };
}

describe('Proxmox firewall state convergence', () => {
  it('disables native pre-rule exceptions and confirms the complete round trip', async () => {
    const f = fixture();
    await f.apply();
    expect(f.state.options).toMatchObject({
      enable: 1,
      policy_in: 'DROP',
      policy_out: 'DROP',
      dhcp: 0,
      ndp: 0,
      radv: 1,
    });
    expect(await f.read()).toMatchObject({ enabled: true, matches: true, blockers: [] });
    f.state.options.dhcp = 1;
    expect((await f.read()).matches).toBe(false);
    await f.apply();
    f.state.options.ndp = 1;
    expect((await f.read()).matches).toBe(false);
  });
  it.each([
    { iface: 'net0' },
    { errors: 'invalid binding' },
  ])('rejects a scoped or invalid binding: %j', async (patch) => {
    const f = fixture();
    await f.apply();
    Object.assign(f.state.rules[0]!, patch);
    expect(await f.read()).toMatchObject({ matches: false, blockers: [expect.stringContaining('scoped or invalid')] });
    const writes = f.request.mock.calls.filter(([, o]) => o?.method).length;
    await expect(f.apply()).rejects.toThrow('scoped or invalid');
    expect(f.request.mock.calls.filter(([, o]) => o?.method)).toHaveLength(writes);
  });
  it('can disable with VM.Config.Network alone despite missing activation prerequisites', async () => {
    const f = fixture();
    await f.apply();
    f.state.rootPrivilege = false;
    f.state.cluster.enable = 0;
    f.state.config.net1 = 'virtio=BB';
    const disabled = { ...desired, enabled: false };
    const observation = await f.read(disabled);
    expect(observation.blockers).not.toHaveLength(0);
    expect(observation.disableBlockers).toEqual([]);
    await f.apply(disabled);
    expect(f.state.options.enable).toBe(0);
    expect(f.state.rules).toHaveLength(1);
    expect(f.state.rules[0]!.enable).toBe(0);
    expect(f.state.groups.size).toBe(1);
    expect((await f.read(disabled)).matches).toBe(true);
  });
  it('still requires VM write permission when disabling an active policy', async () => {
    const f = fixture();
    await f.apply();
    f.state.vmPrivilege = false;
    await expect(f.apply({ ...desired, enabled: false })).rejects.toThrow('VM.Config.Network');
    expect(f.state.options.enable).toBe(1);
  });
  it('leaves earlier groups immutable and preserves enabled filtering through an edit', async () => {
    const f = fixture();
    await f.apply();
    const previous = structuredClone([...f.state.groups]);
    f.request.mockClear();
    await f.apply({ ...desired, rules: [{ ...desired.rules[0]!, ports: '53' }] });
    expect(f.state.groups.size).toBe(2);
    expect([...f.state.groups][0]).toEqual(previous[0]);
    expect(
      f.request.mock.calls.some(([, o]) => o?.method === 'PUT' && (o.body as Record<string, unknown>).enable === 0)
    ).toBe(false);
  });
  it('rejects a stale off observation after another writer enables filtering', async () => {
    const f = fixture();
    const off = { ...desired, enabled: false };
    const before = await f.read(off);
    await f.apply();
    const adapter = new ProxmoxFirewallAdapter({ request: f.request as never, getResource: async () => resource });
    await expect(adapter.apply(resource, 'owner', off, before)).rejects.toThrow('changed');
    expect(f.state.options.enable).toBe(1);
  });
  it.each(['group', 'binding'])('does not enable when a foreign rule races the %s POST', async (stage) => {
    const f = fixture();
    f.state.beforeRequest = (path, options) => {
      if (options.method !== 'POST') return;
      if (stage === 'group' && path.startsWith('/cluster/firewall/groups/')) {
        f.state.beforeRequest = null;
        [...f.state.groups.values()][0]!.rules.push({ type: 'in', action: 'ACCEPT', enable: 1 });
      } else if (stage === 'binding' && path.endsWith('/firewall/rules')) {
        f.state.beforeRequest = null;
        f.state.rules.push({ type: 'in', action: 'ACCEPT', enable: 1 });
      }
    };
    await expect(f.apply()).rejects.toThrow('filtering was not enabled');
    expect(f.state.options.enable).toBe(0);
  });
  it.each([
    'after-binding',
    'options-put',
  ])('preserves foreign filtering when rules race disable: %s', async (stage) => {
    const f = fixture();
    await f.apply();
    f.state.beforeRequest = (path, options) => {
      const anchorInactive = f.state.rules[0]!.enable === 0;
      const target =
        stage === 'after-binding'
          ? anchorInactive && path.endsWith('/firewall/rules') && !options.method
          : path.endsWith('/firewall/options') &&
            options.method === 'PUT' &&
            (options.body as Record<string, unknown>).enable === 0;
      if (target) {
        f.state.beforeRequest = null;
        f.state.rules.push({ type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22', enable: 1, comment: 'foreign' });
      }
    };
    const disabled = { ...desired, enabled: false };
    await f.apply(disabled);
    expect(f.state.options.enable).toBe(1);
    expect(f.state.rules.find((rule) => rule.comment === 'foreign')?.enable).toBe(1);
    expect(await f.read(disabled)).toMatchObject({ enabled: false, matches: true });
  });
  it('can resume disable after an interrupted options write without losing ownership', async () => {
    const f = fixture();
    await f.apply();
    f.state.beforeRequest = (path, options) => {
      if (path.endsWith('/firewall/options') && options.method === 'PUT') {
        f.state.beforeRequest = null;
        throw new Error('connection lost before options write');
      }
    };
    const disabled = { ...desired, enabled: false };
    await expect(f.apply(disabled)).rejects.toThrow('connection lost');
    expect(f.state.rules[0]!.enable).toBe(0);
    await f.apply(disabled);
    expect(f.state.options.enable).toBe(0);
    expect((await f.read(disabled)).matches).toBe(true);
    await f.apply();
    expect((await f.read()).matches).toBe(true);
  });
  it('restores the prior active binding when the staged group changes during replacement', async () => {
    const f = fixture();
    await f.apply();
    const priorGroup = f.state.rules[0]!.action;
    f.state.beforeRequest = (path, options) => {
      if (path.endsWith('/firewall/rules/0') && options.method === 'PUT') {
        f.state.beforeRequest = null;
        const staged = (options.body as Record<string, string>).action!;
        f.state.groups.get(staged)!.rules.push({ type: 'in', action: 'ACCEPT', enable: 1 });
      }
    };
    await expect(f.apply({ ...desired, rules: [] })).rejects.toThrow('Staged firewall group changed');
    expect(f.state.options.enable).toBe(1);
    expect(f.state.rules[0]!.action).toBe(priorGroup);
    expect((await f.read()).matches).toBe(true);
  });
  it('restores the active binding on a confirmed options conflict without undoing the external option', async () => {
    const f = fixture();
    await f.apply();
    const priorGroup = f.state.rules[0]!.action;
    f.state.beforeRequest = (path, options) => {
      if (path.endsWith('/firewall/options') && !options.method && f.state.rules[0]!.action !== priorGroup) {
        f.state.beforeRequest = null;
        f.state.options.log_level_in = 'info';
      }
    };
    await expect(f.apply({ ...desired, rules: [] })).rejects.toThrow('VM firewall options changed');
    expect(f.state.options).toMatchObject({ enable: 1, log_level_in: 'info' });
    expect(f.state.rules[0]!.action).toBe(priorGroup);
    expect((await f.read()).matches).toBe(true);
  });
});
