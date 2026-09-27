import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostingFirewallConfig } from '../hosting-firewall.types.js';
import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import { type HostingResourceSnapshot, hostingCapabilities } from '../hosting-provider.types.js';
import { CloudBlastApi } from './cloudblast-api.js';
import { CloudBlastFirewallAdapter } from './cloudblast-firewall.js';

const SERVER = '0a1b2c3d-1111-4222-8333-444455556666';
const OTHER = '0a1b2c3d-7777-4888-9999-aaaabbbbcccc';
const OWNER = 'resource-1';
const NAME = `gw-fw-${createHash('sha256').update(`${OWNER}:${SERVER}`).digest('hex').slice(0, 20)}`;
const vm: HostingResourceSnapshot = {
  remoteId: SERVER,
  kind: 'vm',
  name: 'gateway-web',
  location: '',
  powerState: 'running',
  cpu: 2,
  memoryMb: 4096,
  diskGb: 80,
  addresses: [],
  incarnation: `uuid:${SERVER}`,
  capabilities: hostingCapabilities({ start: true }),
  observedAt: '2026-09-05T08:00:00Z',
};
const desired: HostingFirewallConfig = {
  enabled: true,
  inboundPolicy: 'deny',
  outboundPolicy: 'allow',
  rules: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      direction: 'in',
      action: 'allow',
      protocol: 'tcp',
      ports: '8000-8010',
      addresses: ['203.0.113.0/24', '2001:db8::/32'],
      description: 'app',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      direction: 'in',
      action: 'deny',
      protocol: 'icmp',
      ports: 'all',
      addresses: ['198.51.100.7'],
      description: 'block',
    },
  ],
};

type Group = { id: number; name: string; servers: Array<{ uuid: string }>; rules: Array<Record<string, unknown>> };

class FakeCloudBlast implements HostingHttp {
  readonly calls: Array<{ path: string; options: HostingRequestOptions }> = [];
  groups: Group[] = [];
  vmExists = true;
  private nextId = 100;
  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    this.calls.push({ path, options });
    const method = options.method ?? 'GET';
    const body = options.body as Record<string, unknown> | undefined;
    const group = (id: string) => this.groups.find((item) => String(item.id) === id);
    const match = /^\/api\/v2\/security-groups\/(\d+)(.*)$/.exec(path);
    if (path === `/api/v2/servers/${SERVER}`) {
      if (!this.vmExists) throw new HostingProviderError(404, false, 'missing');
      return {} as T;
    }
    if (path === '/api/v2/security-groups' && method === 'GET')
      return {
        data: this.groups.map((item) => ({ id: item.id, name: item.name, vm_count: item.servers.length })),
      } as T;
    if (path === '/api/v2/security-groups' && method === 'POST') {
      const created = { id: this.nextId++, name: String(body!.name), servers: [], rules: [] };
      this.groups.push(created);
      return { data: { id: created.id, name: created.name } } as T;
    }
    const target = match ? group(match[1]!) : undefined;
    if (!match || !target) throw new HostingProviderError(404, false, 'missing');
    const suffix = match[2];
    if (suffix === '' && method === 'GET') return { data: target } as T;
    if (suffix === '' && method === 'DELETE') {
      this.groups = this.groups.filter((item) => item !== target);
      return null as T;
    }
    if (suffix === '/rules' && method === 'POST') {
      target.rules.push({ id: this.nextId++, source: null, destination: null, source_port: null, ...body });
      return { data: {} } as T;
    }
    if (suffix?.startsWith('/rules/') && method === 'DELETE') {
      target.rules = target.rules.filter((rule) => `/rules/${rule.id}` !== suffix);
      return null as T;
    }
    if (suffix === '/servers/attach') target.servers.push({ uuid: String(body!.server_uuid) });
    else if (suffix === '/servers/detach')
      target.servers = target.servers.filter((server) => server.uuid !== body!.server_uuid);
    else throw new Error(`Unexpected ${method} ${path}`);
    return { data: {} } as T;
  }
}

function setup() {
  const http = new FakeCloudBlast();
  const firewall = new CloudBlastFirewallAdapter(new CloudBlastApi(http), async () => (http.vmExists ? vm : null));
  return { http, firewall };
}

describe('CloudBlastFirewallAdapter', () => {
  it('creates an owned security group with ordered explicit rules and attaches only this server', async () => {
    const { http, firewall } = setup();
    const before = await firewall.read(vm, OWNER, desired);
    expect(before).toMatchObject({ enabled: false, matches: false, applying: false, remoteId: null, blockers: [] });
    await firewall.apply(vm, OWNER, desired, before);
    const group = http.groups[0]!;
    expect(group.name).toBe(NAME);
    expect(group.name.length).toBeLessThanOrEqual(30);
    expect(group.servers).toEqual([{ uuid: SERVER }]);
    expect(
      group.rules.map((rule) => [
        rule.type,
        rule.action,
        rule.protocol,
        rule.source ?? null,
        rule.destination_port,
        rule.priority,
      ])
    ).toEqual([
      ['inbound', 'DROP', 'icmp', '198.51.100.7', null, 0],
      ['inbound', 'ACCEPT', 'tcp', '2001:db8::/32', '8000:8010', 1],
      ['inbound', 'ACCEPT', 'tcp', '203.0.113.0/24', '8000:8010', 2],
      ['inbound', 'DROP', 'tcp', null, null, 3],
      ['inbound', 'DROP', 'udp', null, null, 4],
      ['inbound', 'DROP', 'icmp', null, null, 5],
      ['inbound', 'DROP', 'ipv6-icmp', null, null, 6],
      ['outbound', 'ACCEPT', 'tcp', null, null, 7],
      ['outbound', 'ACCEPT', 'udp', null, null, 8],
      ['outbound', 'ACCEPT', 'icmp', null, null, 9],
      ['outbound', 'ACCEPT', 'ipv6-icmp', null, null, 10],
    ]);
    const after = await firewall.read(vm, OWNER, desired);
    expect(after).toMatchObject({ enabled: true, matches: true, remoteId: String(group.id) });
  });

  it('replaces changed rules make-before-break and detaches on disable while keeping the rules', async () => {
    const { http, firewall } = setup();
    await firewall.apply(vm, OWNER, desired, await firewall.read(vm, OWNER, desired));
    const oldIds = http.groups[0]!.rules.map((rule) => rule.id);
    const changed = { ...desired, outboundPolicy: 'deny' as const };
    await firewall.apply(vm, OWNER, changed, await firewall.read(vm, OWNER, changed));
    const writes = http.calls.filter((call) => call.options.method === 'POST' || call.options.method === 'DELETE');
    const lastAdd = writes.map((call) => call.options.method).lastIndexOf('POST');
    const firstDelete = writes.map((call) => call.options.method).indexOf('DELETE');
    expect(firstDelete).toBeGreaterThan(lastAdd);
    expect(http.groups[0]!.rules.some((rule) => oldIds.includes(rule.id))).toBe(false);
    expect((await firewall.read(vm, OWNER, changed)).matches).toBe(true);
    const disabled = { ...changed, enabled: false };
    await firewall.apply(vm, OWNER, disabled, await firewall.read(vm, OWNER, disabled));
    expect(http.groups[0]!.servers).toEqual([]);
    expect(http.groups[0]!.rules).toHaveLength(11);
    expect((await firewall.read(vm, OWNER, disabled)).matches).toBe(true);
  });

  it('blocks other attached groups, shared ownership and unrepresentable rules', async () => {
    const { http, firewall } = setup();
    http.groups = [
      { id: 1, name: 'web', servers: [{ uuid: SERVER }], rules: [] },
      {
        id: 2,
        name: NAME,
        servers: [{ uuid: OTHER }],
        rules: [{ id: 5, type: 'inbound', action: 'ACCEPT', protocol: 'tcp', source: null, source_port: '1000' }],
      },
    ];
    const observation = await firewall.read(vm, OWNER, desired);
    expect(observation.blockers.join(' ')).toMatch(/other CloudBlast security groups: web/);
    expect(observation.blockers.join(' ')).toMatch(/cannot represent/);
    expect(observation.disableBlockers?.join(' ')).toMatch(/attached to another server/);
    await expect(firewall.apply(vm, OWNER, desired, observation)).rejects.toMatchObject({ providerStatus: 409 });
    expect(http.calls.some((call) => call.options.method && call.options.method !== 'GET')).toBe(false);
  });

  it('refuses a stale observation', async () => {
    const { http, firewall } = setup();
    const observation = await firewall.read(vm, OWNER, desired);
    http.groups.push({ id: 9, name: NAME, servers: [], rules: [] });
    await expect(firewall.apply(vm, OWNER, desired, observation)).rejects.toThrow(/changed/);
  });

  it('reports missing permissions as a blocker instead of failing the read', async () => {
    const firewall = new CloudBlastFirewallAdapter(
      new CloudBlastApi({
        request: async () => {
          throw new HostingProviderError(403, false, 'denied');
        },
      }),
      async () => vm
    );
    await expect(firewall.read(vm, OWNER, desired)).resolves.toMatchObject({
      matches: false,
      blockers: ['CloudBlast token cannot read security groups.'],
    });
  });

  it('deletes only an unattached owned group after the server is gone', async () => {
    const { http, firewall } = setup();
    await firewall.apply(vm, OWNER, desired, await firewall.read(vm, OWNER, desired));
    const fences: string[] = [];
    await expect(firewall.cleanup(vm, OWNER, null, false, async (id) => void fences.push(id))).rejects.toThrow(
      /still exists/
    );
    http.vmExists = false;
    await expect(firewall.cleanup(vm, OWNER, null, false, async (id) => void fences.push(id))).resolves.toMatchObject({
      status: 'preserved',
    });
    http.groups[0]!.servers = [];
    const groupId = String(http.groups[0]!.id);
    await expect(firewall.cleanup(vm, OWNER, null, false, async (id) => void fences.push(id))).resolves.toEqual({
      status: 'deleted',
      remoteId: groupId,
    });
    expect(fences).toEqual([groupId]);
    expect(http.groups).toEqual([]);
    await expect(firewall.cleanup(vm, OWNER, groupId, true, async () => undefined)).resolves.toMatchObject({
      status: 'absent',
    });
  });
});
