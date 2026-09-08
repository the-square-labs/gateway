import { describe, expect, it } from 'vitest';
import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import { applyHostingImagePolicy } from '../hosting-image-policy.js';
import type { HostingConnection, HostingCreateRequest, HostingResourceSnapshot } from '../hosting-provider.types.js';
import { hostingCapabilities } from '../hosting-provider.types.js';
import { DigitalOceanHostingAdapter } from './digitalocean.js';

interface RequestCall {
  path: string;
  options: HostingRequestOptions;
}

type RequestHandler = (path: string, options: HostingRequestOptions) => unknown | Promise<unknown>;

class FakeHostingHttp implements HostingHttp {
  readonly calls: RequestCall[] = [];
  tokenInfo: unknown = { scopes: ['api:write'] };
  scopeReads = 0;

  constructor(private readonly handler: RequestHandler) {}

  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    if (path === '/v1/oauth/token/info') {
      this.scopeReads += 1;
      if (this.tokenInfo instanceof Error) throw this.tokenInfo;
      return this.tokenInfo as T;
    }
    this.calls.push({ path, options });
    return (await this.handler(path, options)) as T;
  }
}

const connection: HostingConnection = {
  provider: 'digitalocean',
  baseUrl: 'https://api.digitalocean.com',
  token: 'test-token',
  settings: {
    kind: 'hosting',
    autoSyncEnabled: false,
    autoSyncIntervalSeconds: 60,
    resourceIds: [],
    adoptionNodeIds: [],
    adoptionEnabled: false,
  },
};

const markerTag = 'gw-01234567-89ab-cdef-0123-456789abcdef';

it('keeps VM monthly expenses without billing access and never requests invoices or history', async () => {
  const http = new FakeHostingHttp(() => {
    throw new HostingProviderError(403, false, 'Denied');
  });
  const adapter = new DigitalOceanHostingAdapter(connection, http);
  const result = await adapter.accountSummary([
    { price: { amount: '6', currency: 'USD', period: 'month', estimated: true } } as HostingResourceSnapshot,
  ]);
  expect(result.balance).toBeNull();
  expect(result.monthlyExpenses?.amount).toBe('6.00');
  expect(http.calls.map((call) => call.path)).toEqual(['/v2/customers/my/balance']);
});

const droplet = {
  id: 123,
  name: 'gateway-web',
  status: 'active',
  created_at: '2026-09-05T08:00:00Z',
  region: { slug: 'nyc3', name: 'New York 3' },
  size_slug: 's-2vcpu-4gb',
  size: {
    slug: 's-2vcpu-4gb',
    vcpus: 2,
    memory: 4096,
    disk: 80,
    price_hourly: 0.0357,
    price_monthly: 24,
  },
  image: { id: 999, slug: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04 x64' },
  networks: {
    v4: [
      { ip_address: '10.0.0.2', type: 'private' },
      { ip_address: '203.0.113.10', type: 'public' },
    ],
    v6: [{ ip_address: '2001:db8::10', type: 'public' }],
  },
  tags: ['unrelated-tag', markerTag],
};

function resource(): HostingResourceSnapshot {
  return {
    remoteId: '123',
    kind: 'vm',
    name: 'gateway-web',
    location: 'nyc3',
    powerState: 'running',
    cpu: 2,
    memoryMb: 4096,
    diskGb: 80,
    sizeId: 's-2vcpu-4gb',
    imageId: 'ubuntu-24-04-x64',
    addresses: [],
    incarnation: '2026-09-05T08:00:00Z',
    capabilities: hostingCapabilities({ start: true, shutdown: true, reboot: true, resize: true, delete: true }),
    observedAt: '2026-09-05T08:00:00Z',
  };
}

describe('DigitalOceanHostingAdapter', () => {
  it('keeps an inventory-only token connected without billing or write access', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v2/account') return { account: { uuid: 'account' } };
      if (path === '/v2/droplets') return { droplets: [droplet] };
      throw new Error('Unexpected provider read');
    });
    http.tokenInfo = { scopes: ['account:read', 'droplet:read'] };
    const adapter = new DigitalOceanHostingAdapter(connection, http);
    const account = await adapter.test();
    expect(account.capabilities.create).toMatchObject({ available: false, reasonCode: 'permission_denied' });
    expect(account.capabilities.create.reason).toContain('tag:create');
    expect(account.capabilities.finance.available).toBe(false);
    expect((await adapter.listResources()).resources[0]?.capabilities.start.available).toBe(false);
    expect(await adapter.catalog()).toEqual({ locations: [], sizes: [], images: [] });
    expect(http.scopeReads).toBe(1);
    expect(http.calls.map((call) => call.path)).toEqual(['/v2/account', '/v2/droplets']);
  });
  it.each(['api:write', 'write'])('recognizes full-access alias %s', async (alias) => {
    const http = new FakeHostingHttp((path) => (path === '/v2/account' ? { account: { uuid: 'account' } } : {}));
    http.tokenInfo = { scopes: [alias] };
    const account = await new DigitalOceanHostingAdapter(connection, http).test();
    for (const action of ['create', 'start', 'shutdown', 'reboot', 'resize', 'delete', 'finance'] as const)
      expect(account.capabilities[action].available).toBe(true);
  });
  it.each(['api:read', 'read'])('does not grant mutations for read-only alias %s', async (alias) => {
    const http = new FakeHostingHttp((path) => (path === '/v2/account' ? { account: { uuid: 'account' } } : {}));
    http.tokenInfo = { scopes: [alias] };
    const account = await new DigitalOceanHostingAdapter(connection, http).test();
    for (const action of ['create', 'start', 'shutdown', 'reboot', 'resize', 'delete'] as const)
      expect(account.capabilities[action].available).toBe(false);
  });
  it('requires tag:create for marked creation and checks again after scopes change', async () => {
    const http = new FakeHostingHttp(() => ({ droplet }));
    const request: HostingCreateRequest = {
      name: 'worker',
      location: 'nyc3',
      size: 'small',
      image: 'ubuntu',
      marker: markerTag,
      userData: '',
    };
    const adapter = new DigitalOceanHostingAdapter(connection, http);
    await adapter.validateCreate();
    http.tokenInfo = { scopes: ['api:read', 'droplet:create'] };
    await expect(adapter.create(request)).rejects.toMatchObject({
      providerStatus: 403,
      outcomeUnknown: false,
      message: 'DigitalOcean token is missing required scopes: tag:create.',
    });
    expect(http.calls).toHaveLength(0);
    expect(http.scopeReads).toBe(2);
    http.tokenInfo = { scopes: ['api:read', 'droplet:create', 'tag:create'] };
    await adapter.create(request);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.options.body).toMatchObject({ tags: [markerTag] });
  });
  it('checks update, resize and delete independently and does not reuse stale write scopes', async () => {
    const http = new FakeHostingHttp(() => ({ action: { id: 42, status: 'completed', resource_id: 123 } }));
    http.tokenInfo = { scopes: ['api:read', 'droplet:update'] };
    const adapter = new DigitalOceanHostingAdapter(connection, http);
    await adapter.action(resource(), { action: 'reboot' });
    await expect(adapter.action(resource(), { action: 'resize', size: 'large' })).rejects.toThrow('droplet:create');
    await expect(adapter.action(resource(), { action: 'delete' })).rejects.toThrow('droplet:delete');
    http.tokenInfo = { scopes: ['api:read'] };
    await expect(adapter.action(resource(), { action: 'start' })).rejects.toThrow('droplet:update');
    expect(http.calls).toHaveLength(1);
  });
  it.each([
    {},
    { scopes: 'write' },
    { scopes: ['secret payload!'] },
    { scopes: [null] },
  ])('fails closed for invalid token-info without echoing its contents', async (tokenInfo) => {
    const http = new FakeHostingHttp(() => null);
    http.tokenInfo = tokenInfo;
    await expect(new DigitalOceanHostingAdapter(connection, http).test()).rejects.toMatchObject({
      providerStatus: 502,
      message: 'DigitalOcean returned invalid token scopes; permissions could not be verified',
    });
    expect(http.calls).toHaveLength(0);
  });
  it('rejects missing inventory scopes during connection', async () => {
    const http = new FakeHostingHttp(() => null);
    http.tokenInfo = { scopes: ['account:read'] };
    await expect(new DigitalOceanHostingAdapter(connection, http).test()).rejects.toThrow('droplet:read');
    expect(http.calls).toHaveLength(0);
  });
  it('preserves sanitized provider errors and does not treat introspection 404 as a missing VM', async () => {
    const failure = new HostingProviderError(403, false, 'DigitalOcean: action denied (HTTP 403).');
    const http = new FakeHostingHttp(() => {
      throw failure;
    });
    await expect(new DigitalOceanHostingAdapter(connection, http).test()).rejects.toBe(failure);
    const introspection = new FakeHostingHttp(() => ({ droplet }));
    introspection.tokenInfo = new HostingProviderError(404, false, 'Token introspection unavailable');
    await expect(new DigitalOceanHostingAdapter(connection, introspection).getResource('123')).rejects.toThrow(
      'Token introspection unavailable'
    );
  });
  it('uses the provider account UUID as stable authority', async () => {
    let account: unknown = { uuid: 'account-uuid-a', email: 'owner-a@example.com' };
    const http = new FakeHostingHttp((path) =>
      path === '/v2/account' ? { account } : { account_balance: '0.00', month_to_date_usage: '0.00' }
    );
    const first = await new DigitalOceanHostingAdapter({ ...connection, token: 'token-a' }, http).test();

    account = { uuid: 'account-uuid-b', name: 'owner-b' };
    const second = await new DigitalOceanHostingAdapter({ ...connection, token: 'token-b' }, http).test();

    expect(first).toMatchObject({ authority: 'account-uuid-a', name: 'owner-a@example.com' });
    expect(second).toMatchObject({ authority: 'account-uuid-b', name: 'owner-b' });
    expect(first.authority).not.toBe(second.authority);
    expect(http.calls).toEqual([
      { path: '/v2/account', options: {} },
      { path: '/v2/customers/my/balance', options: {} },
      { path: '/v2/account', options: {} },
      { path: '/v2/customers/my/balance', options: {} },
    ]);

    account = { email: 'missing-uuid@example.com' };
    await expect(new DigitalOceanHostingAdapter(connection, http).test()).rejects.toMatchObject({
      providerStatus: 502,
    });
  });
  it('disables finance only when the verified billing probe is denied', async () => {
    const denied = new FakeHostingHttp((path) => {
      if (path === '/v2/account') return { account: { uuid: 'account-uuid', email: 'owner@example.com' } };
      throw new HostingProviderError(403, false, 'billing scope denied');
    });
    await expect(new DigitalOceanHostingAdapter(connection, denied).test()).resolves.toMatchObject({
      authority: 'account-uuid',
      capabilities: {
        create: { available: true },
        finance: {
          available: false,
          reasonCode: 'permission_denied',
        },
      },
    });

    const unavailable = new FakeHostingHttp((path) => {
      if (path === '/v2/account') return { account: { uuid: 'account-uuid', email: 'owner@example.com' } };
      throw new HostingProviderError(500, false, 'billing service error');
    });
    await expect(new DigitalOceanHostingAdapter(connection, unavailable).test()).rejects.toMatchObject({
      providerStatus: 500,
    });
  });

  it('normalizes catalogs and filters DigitalOcean images to distributions', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v2/regions') return { regions: [{ slug: 'nyc3', name: 'New York 3' }] };
      if (path === '/v2/sizes') {
        return {
          sizes: [
            {
              slug: 's-2vcpu-4gb',
              description: 'Basic 2 vCPU',
              vcpus: 2,
              memory: 4096,
              disk: 80,
              regions: ['nyc3'],
              price_monthly: 24,
              price_hourly: 0.0357,
            },
          ],
        };
      }
      return {
        images: [
          {
            id: 999,
            slug: 'ubuntu-24-04-x64',
            name: 'Ubuntu 24.04 x64',
            distribution: 'Ubuntu',
            regions: ['nyc3'],
          },
        ],
      };
    });
    const adapter = new DigitalOceanHostingAdapter(connection, http);

    await expect(adapter.catalog()).resolves.toEqual({
      locations: [{ id: 'nyc3', name: 'New York, United States (nyc3)' }],
      sizes: [
        {
          id: 's-2vcpu-4gb',
          name: 'Basic 2 vCPU',
          cpu: 2,
          memoryMb: 4096,
          diskGb: 80,
          locations: ['nyc3'],
          price: { amount: '24', currency: 'USD', estimated: true, period: 'month' },
        },
      ],
      images: [{ id: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04 x64', locations: ['nyc3'] }],
    });
    expect(http.calls).toEqual([
      { path: '/v2/regions', options: { query: { page: 1, per_page: 200 } } },
      { path: '/v2/sizes', options: { query: { page: 1, per_page: 200 } } },
      {
        path: '/v2/images',
        options: { query: { type: 'distribution', page: 1, per_page: 200 } },
      },
    ]);
  });

  it('admits compatible public OS versions independently of the Proxmox catalog', async () => {
    const candidates = [
      { slug: 'ubuntu-24-04-x64', name: '24.04 LTS x64', distribution: 'Ubuntu', public: true },
      { slug: 'debian-13-x64', name: '13 x64', distribution: 'Debian', public: true },
      { slug: 'fedora-44-x64', name: '44 x64', distribution: 'Fedora', public: true },
      { slug: 'ubuntu-26-04-x64', distribution: 'Ubuntu', public: true },
      { slug: 'ubuntu-22-04-x64', distribution: 'Ubuntu', public: true },
      { slug: 'ubuntu-28-04-x64', distribution: 'Ubuntu', public: true },
      { slug: 'ubuntu-24-04-x64-nvidia', distribution: 'Ubuntu', public: true },
      { slug: 'ubuntu-24-04-x64', distribution: 'Ubuntu', public: false },
      { slug: 'debian-13-x64', distribution: 'Unknown', public: true },
      { id: 999, name: 'Ubuntu 24.04', distribution: 'Ubuntu', public: false },
    ];
    const http = new FakeHostingHttp((path) =>
      path === '/v2/regions' ? { regions: [] } : path === '/v2/sizes' ? { sizes: [] } : { images: candidates }
    );
    const catalog = applyHostingImagePolicy(
      await new DigitalOceanHostingAdapter(connection, http).catalog(),
      'digitalocean'
    );
    expect(catalog.images.map((image) => image.id)).toEqual([
      'ubuntu-24-04-x64',
      'debian-13-x64',
      'fedora-44-x64',
      'ubuntu-26-04-x64',
      'ubuntu-22-04-x64',
    ]);
    expect(
      catalog.images.every(
        (image) => image.supportedRoles?.includes('docker') && image.supportedRoles.includes('relay')
      )
    ).toBe(true);
  });

  it.each([
    ['13 x64', 'Debian', 'Debian 13 x64'],
    ['43 x64', 'Fedora', 'Fedora 43 x64'],
    ['9 Stream x64', 'CentOS', 'CentOS 9 Stream x64'],
    ['AlmaLinux 8', 'AlmaLinux', 'AlmaLinux 8'],
    ['ubuntu 24.04 x64', 'Ubuntu', 'ubuntu 24.04 x64'],
    [undefined, 'Debian', 'Debian'],
    ['Custom Linux', undefined, 'Custom Linux'],
    [undefined, undefined, 'image-slug'],
  ])('includes the image distribution without duplicating it: %s / %s', async (name, distribution, expected) => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v2/regions') return { regions: [] };
      if (path === '/v2/sizes') return { sizes: [] };
      return { images: [{ id: 999, slug: 'image-slug', name, distribution, regions: ['nyc3'] }] };
    });
    const catalog = await new DigitalOceanHostingAdapter(connection, http).catalog();
    expect(catalog.images).toEqual([{ id: 'image-slug', name: expected, locations: ['nyc3'] }]);
  });

  it('allows pinned Ubuntu GPU builds only on matching vendor and GPU count', async () => {
    const sizes = ['s-2vcpu-4gb', 'gpu-h100x1-80gb', 'gpu-h100x8-640gb', 'gpu-mi300x1-192gb', 'gpu-mi300x8-1536gb'];
    const images = [
      { id: 236925144, slug: 'gpu-h100x1-base' },
      { id: 241105730, slug: 'gpu-h100x8-base' },
      { id: 240977387, slug: 'gpu-amd-base' },
      { id: 999, slug: 'gpu-h100x1-base' },
    ].map((image) => ({ ...image, name: 'NVIDIA AI/ML', distribution: 'Ubuntu', public: true }));
    const http = new FakeHostingHttp((path) =>
      path === '/v2/regions'
        ? { regions: [] }
        : path === '/v2/sizes'
          ? { sizes: sizes.map((slug) => ({ slug })) }
          : { images }
    );
    const catalog = applyHostingImagePolicy(
      await new DigitalOceanHostingAdapter(connection, http).catalog(),
      'digitalocean'
    );
    expect(catalog.images.map((image) => [image.id, image.compatibleSizes])).toEqual([
      ['236925144', ['gpu-h100x1-80gb']],
      ['241105730', ['gpu-h100x8-640gb']],
      ['240977387', ['gpu-mi300x1-192gb', 'gpu-mi300x8-1536gb']],
    ]);
    for (const image of catalog.images)
      expect(image.operatingSystem).toEqual({ distribution: 'ubuntu', version: '24.04' });
  });

  it('fully paginates droplets and keeps assigned interface addresses direct', async () => {
    const http = new FakeHostingHttp((path, options) => {
      if (path !== '/v2/droplets') throw new Error('unexpected path');
      const page = options.query?.page;
      if (page === 1) {
        return {
          droplets: [droplet],
          links: {
            pages: { next: 'https://api.digitalocean.com/v2/droplets?page=2&per_page=200' },
          },
        };
      }
      return { droplets: [] };
    });
    const adapter = new DigitalOceanHostingAdapter(connection, http);

    const inventory = await adapter.listResources();
    expect(inventory.complete).toBe(true);
    expect(inventory.resources[0]).toMatchObject({
      remoteId: '123',
      location: 'nyc3',
      powerState: 'running',
      cpu: 2,
      memoryMb: 4096,
      diskGb: 80,
      sizeId: 's-2vcpu-4gb',
      imageId: 'ubuntu-24-04-x64',
      incarnation: '2026-09-05T08:00:00Z',
      marker: markerTag,
    });
    expect(inventory.resources[0]?.addresses).toEqual([
      { ip: '10.0.0.2', network: 'private', direct: true },
      { ip: '203.0.113.10', network: 'public', direct: true },
      { ip: '2001:db8::10', network: 'public', direct: true },
    ]);
    expect(http.calls.map((call) => call.options.query?.page)).toEqual([1, 2]);
  });

  it('creates with user data and marker, then returns the provider resource id', async () => {
    const http = new FakeHostingHttp((path, options) => {
      expect(path).toBe('/v2/droplets');
      expect(options).toMatchObject({ method: 'POST' });
      return { droplet };
    });
    const adapter = new DigitalOceanHostingAdapter(connection, http);
    const request: HostingCreateRequest = {
      name: 'gateway-web',
      location: 'nyc3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      marker: markerTag,
      userData: '#cloud-config\nruncmd: []',
    };

    await expect(adapter.create(request)).resolves.toEqual({
      id: null,
      resourceId: '123',
      status: 'succeeded',
    });
    expect(http.calls[0]?.options.body).toEqual({
      name: 'gateway-web',
      region: 'nyc3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      user_data: '#cloud-config\nruncmd: []',
      tags: [markerTag],
    });
    await adapter.create({ ...request, image: '236925144' });
    expect(http.calls[1]?.options.body).toMatchObject({ image: 236925144 });
  });

  it('dispatches each action once and reads action status without polling', async () => {
    const http = new FakeHostingHttp((path, _options) => {
      if (path.endsWith('/actions')) return { action: { id: 42, status: 'in-progress', resource_id: 123 } };
      if (path === '/v2/actions/42') return { action: { id: 42, status: 'completed', resource_id: 123 } };
      if (path === '/v2/actions/43') return { action: { id: 43, status: 'success', resource_id: 123 } };
      if (path === '/v2/actions/44') return { action: { id: 44, status: 'succeeded', resource_id: 123 } };
      return null;
    });
    const adapter = new DigitalOceanHostingAdapter(connection, http);

    await expect(adapter.action(resource(), { action: 'start' })).resolves.toEqual({
      id: '42',
      resourceId: '123',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'resize', size: 's-4vcpu-8gb' })).resolves.toEqual({
      id: '42',
      resourceId: '123',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'delete' })).resolves.toEqual({
      id: null,
      resourceId: '123',
      status: 'succeeded',
    });
    await expect(adapter.operation('42', '123')).resolves.toEqual({
      id: '42',
      resourceId: '123',
      status: 'succeeded',
    });
    await expect(adapter.operation('43', '123')).resolves.toEqual({
      id: '43',
      resourceId: '123',
      status: 'unknown',
    });
    await expect(adapter.operation('44', '123')).resolves.toEqual({
      id: '44',
      resourceId: '123',
      status: 'unknown',
    });

    expect(http.calls.map((call) => call.path)).toEqual([
      '/v2/droplets/123/actions',
      '/v2/droplets/123/actions',
      '/v2/droplets/123',
      '/v2/actions/42',
      '/v2/actions/43',
      '/v2/actions/44',
    ]);
    expect(http.calls[0]?.options.body).toEqual({ type: 'power_on' });
    expect(http.calls[1]?.options.body).toEqual({ type: 'resize', size: 's-4vcpu-8gb' });
  });

  it('reads finance and invoice detail through read-only endpoints', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v2/customers/my/balance') return { account_balance: '12.50', month_to_date_usage: '3.25' };
      if (path === '/v2/customers/my/invoices') {
        return {
          invoices: [{ invoice_uuid: 'inv-1', status: 'paid', amount: '3.25', date: '2026-09-01' }],
        };
      }
      if (path === '/v2/customers/my/billing_history') {
        return {
          billing_history: [{ invoice_id: 'inv-1', description: 'Droplet usage', amount: '-3.25', date: '2026-09-01' }],
        };
      }
      return { invoice: { invoice_uuid: 'inv-1', status: 'paid', amount: '3.25', date: '2026-09-01' } };
    });
    const adapter = new DigitalOceanHostingAdapter(connection, http);

    await expect(adapter.finance()).resolves.toMatchObject({
      balance: { amount: '12.50', currency: 'USD', estimated: false },
      usage: { amount: '3.25', currency: 'USD', estimated: false },
      invoices: [{ id: 'inv-1', status: 'paid', total: { amount: '3.25', currency: 'USD' } }],
      transactions: [{ id: 'inv-1', description: 'Droplet usage', amount: { amount: '-3.25', currency: 'USD' } }],
    });
    await expect(adapter.invoice('inv-1')).resolves.toEqual({
      id: 'inv-1',
      status: 'paid',
      total: { amount: '3.25', currency: 'USD', estimated: false },
      date: '2026-09-01',
    });
    expect(http.calls.map((call) => call.path)).toEqual([
      '/v2/customers/my/balance',
      '/v2/customers/my/invoices',
      '/v2/customers/my/billing_history',
      '/v2/customers/my/invoices/inv-1',
    ]);
  });

  it('returns null only for provider 404 and rejects unsafe responses without payload leakage', async () => {
    const notFoundHttp = new FakeHostingHttp(() => {
      throw new HostingProviderError(404, false, 'Provider returned HTTP 404');
    });
    await expect(new DigitalOceanHostingAdapter(connection, notFoundHttp).getResource('123')).resolves.toBeNull();

    const unsafeHttp = new FakeHostingHttp(() => ({ droplets: 'not-an-array', provider_secret: 'do-not-leak' }));
    await expect(new DigitalOceanHostingAdapter(connection, unsafeHttp).listResources()).rejects.toMatchObject({
      providerStatus: 502,
      message: 'Provider returned an unsafe response',
    });

    const rawErrorHttp = new FakeHostingHttp(() => {
      throw new Error('provider payload with secret');
    });
    await expect(new DigitalOceanHostingAdapter(connection, rawErrorHttp).test()).rejects.toMatchObject({
      message: 'Provider request failed',
    });
  });

  it('rejects ambiguous markers and marks malformed POST replies as unknown outcome', async () => {
    const ambiguousHttp = new FakeHostingHttp(() => ({
      droplets: [{ ...droplet, tags: [markerTag, 'gw-fedcba98-7654-3210-fedc-ba9876543210'] }],
    }));
    await expect(new DigitalOceanHostingAdapter(connection, ambiguousHttp).listResources()).rejects.toMatchObject({
      providerStatus: 502,
      outcomeUnknown: false,
    });

    const malformedHttp = new FakeHostingHttp((path) => {
      if (path === '/v2/droplets' || path.endsWith('/actions')) return {};
      return null;
    });
    const adapter = new DigitalOceanHostingAdapter(connection, malformedHttp);
    const request: HostingCreateRequest = {
      name: 'gateway-web',
      location: 'nyc3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      marker: markerTag,
      userData: '#cloud-config\nruncmd: []',
    };
    await expect(adapter.create(request)).rejects.toMatchObject({
      providerStatus: 502,
      outcomeUnknown: true,
    });
    await expect(adapter.action(resource(), { action: 'start' })).rejects.toMatchObject({
      providerStatus: 502,
      outcomeUnknown: true,
    });
  });
});
