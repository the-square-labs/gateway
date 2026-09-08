import { describe, expect, it } from 'vitest';
import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import { applyHostingImagePolicy } from '../hosting-image-policy.js';
import {
  type HostingConnection,
  type HostingCreateRequest,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { HetznerHostingAdapter } from './hetzner.js';

interface RequestCall {
  path: string;
  options: HostingRequestOptions;
}

type RequestHandler = (path: string, options: HostingRequestOptions) => unknown | Promise<unknown>;

class FakeHostingHttp implements HostingHttp {
  readonly calls: RequestCall[] = [];

  constructor(private readonly handler: RequestHandler) {}

  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    this.calls.push({ path, options });
    return (await this.handler(path, options)) as T;
  }
}

const connection: HostingConnection = {
  provider: 'hetzner',
  baseUrl: 'https://api.hetzner.cloud',
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

const serverType = {
  id: 1,
  name: 'cpx22',
  cores: 2,
  memory: 4,
  disk: 80,
  architecture: 'x86',
};

const server = {
  id: 9,
  name: 'gateway-web',
  status: 'running',
  created: '2026-09-05T08:00:00Z',
  server_type: serverType,
  image: { id: 100, name: 'Ubuntu 24.04', architecture: 'x86' },
  datacenter: {
    name: 'fsn1-dc14',
    location: { id: 1, name: 'fsn1', city: 'Falkenstein', country: 'DE', description: 'Falkenstein DC Park 1' },
  },
  public_net: {
    ipv4: { ip: '203.0.113.20', blocked: false, dns_ptr: 'gateway.example.com' },
    ipv6: { ip: '2001:db8::20', blocked: false, dns_ptr: null },
    alias_ips: ['203.0.113.21'],
  },
  private_net: [{ ip: '10.0.0.20', mac_address: '86:00:00:00:00:20', network: 4711, alias_ips: ['10.0.0.21'] }],
  labels: { marker: 'request-456' },
};

function resource(): HostingResourceSnapshot {
  return {
    remoteId: '9',
    kind: 'vm',
    name: 'gateway-web',
    location: 'fsn1',
    powerState: 'running',
    cpu: 2,
    memoryMb: 4096,
    diskGb: 80,
    sizeId: '1',
    imageId: '100',
    addresses: [],
    incarnation: '2026-09-05T08:00:00Z',
    capabilities: hostingCapabilities({ start: true, shutdown: true, reboot: true, resize: true, delete: true }),
    observedAt: '2026-09-05T08:00:00Z',
  };
}

describe('HetznerHostingAdapter', () => {
  it('excludes priced but unavailable regional types and types with no available locations', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v1/locations') return { locations: [{ name: 'fsn1' }, { name: 'ash' }] };
      if (path === '/v1/images') return { images: [] };
      if (path === '/v1/server_types')
        return {
          server_types: [
            {
              ...serverType,
              locations: [
                { name: 'fsn1', available: false },
                { name: 'ash', available: true },
              ],
            },
            { ...serverType, id: 2, locations: [{ name: 'fsn1', available: false }] },
            { ...serverType, id: 3, locations: [] },
          ],
        };
      return {
        pricing: {
          currency: 'USD',
          server_types: [1, 2, 3].map((id) => ({
            id,
            prices: ['fsn1', 'ash'].map((location) => ({ location, price_monthly: { gross: '5.9900000000000000' } })),
          })),
        },
      };
    });
    const catalog = await new HetznerHostingAdapter(connection, http).catalog();
    expect(catalog.sizes).toHaveLength(1);
    expect(catalog.sizes[0].locations).toEqual(['ash']);
    expect(catalog.sizes[0].locationPrices).not.toHaveProperty('fsn1');
    expect(catalog.sizes[0].price?.amount).toBe('5.9900000000000000');
  });
  it('admits only known system images of the allowed version and architecture', async () => {
    const names = [
      { id: 1, name: 'ubuntu-24.04', type: 'system', architecture: 'x86' },
      { id: 2, name: 'debian-13', type: 'system', architecture: 'x86' },
      { id: 3, name: 'ubuntu-24.04', type: 'snapshot', architecture: 'x86' },
      { id: 4, name: 'debian-13', type: 'system', architecture: 'arm' },
      { id: 5, name: 'ubuntu-24.04-docker', type: 'system', architecture: 'x86' },
      { id: 6, name: 'ubuntu-26.04', type: 'system', architecture: 'x86' },
      { id: 7, name: 'ubuntu-24.04', type: 'system', architecture: 'x86', deprecated: '2026-01-01' },
    ];
    const http = new FakeHostingHttp((path) =>
      path === '/v1/locations'
        ? { locations: [] }
        : path === '/v1/server_types'
          ? { server_types: [] }
          : path === '/v1/images'
            ? { images: names }
            : { pricing: { currency: 'EUR', server_types: [] } }
    );
    const catalog = applyHostingImagePolicy(await new HetznerHostingAdapter(connection, http).catalog(), 'hetzner');
    expect(catalog.images.map((image) => image.id)).toEqual(['1', '2', '6']);
  });
  it('tests access through the read-only server endpoint with a stable authority', async () => {
    const http = new FakeHostingHttp(() => ({ servers: [] }));
    const adapter = new HetznerHostingAdapter(connection, http);

    await expect(adapter.test()).resolves.toMatchObject({
      authority: 'hetzner-cloud',
      name: 'Hetzner Cloud',
      capabilities: {
        create: { available: true },
        finance: { available: false },
        topup: { available: false },
      },
    });
    expect(http.calls).toEqual([{ path: '/v1/servers', options: { query: { page: 1, per_page: 1 } } }]);
  });

  it('normalizes locations, server types, images, and pricing', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v1/locations') return { locations: [{ id: 1, name: 'fsn1', city: 'Falkenstein', country: 'DE' }] };
      if (path === '/v1/server_types') return { server_types: [serverType] };
      if (path === '/v1/images')
        return { images: [{ id: 100, name: 'Ubuntu 24.04', architecture: 'x86', locations: ['fsn1'] }] };
      return {
        pricing: {
          currency: 'EUR',
          server_types: [
            {
              id: 1,
              name: 'cpx22',
              prices: [
                {
                  location: 'fsn1',
                  price_hourly: { net: '0.0100', gross: '0.0119' },
                  price_monthly: { net: '4.0000', gross: '4.7600' },
                },
                {
                  location: 'nbg1',
                  price_hourly: { net: '0.0200', gross: '0.0238' },
                  price_monthly: { net: '5.0000', gross: '5.9500' },
                },
              ],
            },
          ],
        },
      };
    });
    const adapter = new HetznerHostingAdapter(connection, http);

    const catalog = await adapter.catalog();
    expect(catalog).toEqual({
      locations: [{ id: 'fsn1', name: 'Falkenstein, Germany (fsn1)' }],
      sizes: [
        {
          id: '1',
          name: 'cpx22',
          locations: ['fsn1', 'nbg1'],
          cpu: 2,
          memoryMb: 4096,
          diskGb: 80,
          architecture: 'x64',
          locationPrices: {
            fsn1: { amount: '4.7600', currency: 'EUR', estimated: true, period: 'month' },
            nbg1: { amount: '5.9500', currency: 'EUR', estimated: true, period: 'month' },
          },
          price: { amount: '4.7600', currency: 'EUR', estimated: true, period: 'month' },
        },
      ],
      images: [{ id: '100', name: 'Ubuntu 24.04', architecture: 'x64', locations: ['fsn1'] }],
    });
    const selectedLocation = catalog.locations[0]!.id;
    const availableSizes = catalog.sizes.filter(
      (size) => !size.locations?.length || size.locations.includes(selectedLocation)
    );
    expect(availableSizes).toHaveLength(1);
    expect(availableSizes[0]?.locationPrices?.[selectedLocation]?.amount).toBe('4.7600');
    expect(catalog.images[0]?.locations).toContain(selectedLocation);
    expect(http.calls.map((call) => call.path)).toEqual([
      '/v1/locations',
      '/v1/server_types',
      '/v1/images',
      '/v1/pricing',
    ]);
  });

  it('fully paginates servers and preserves provider-assigned public and private addresses', async () => {
    const http = new FakeHostingHttp((path, options) => {
      if (path !== '/v1/servers') throw new Error('unexpected path');
      const page = options.query?.page;
      if (page === 1) {
        return {
          servers: [server],
          meta: { pagination: { page: 1, per_page: 50, next_page: 2, last_page: 2, total_entries: 51 } },
        };
      }
      return {
        servers: [],
        meta: { pagination: { page: 2, per_page: 50, next_page: null, last_page: 2, total_entries: 51 } },
      };
    });
    const adapter = new HetznerHostingAdapter(connection, http);

    const inventory = await adapter.listResources();
    expect(inventory.complete).toBe(true);
    expect(inventory.resources[0]).toMatchObject({
      remoteId: '9',
      location: 'fsn1',
      powerState: 'running',
      cpu: 2,
      memoryMb: 4096,
      diskGb: 80,
      sizeId: '1',
      imageId: '100',
      incarnation: '2026-09-05T08:00:00Z',
      marker: 'request-456',
    });
    expect(inventory.resources[0]?.addresses).toEqual([
      { ip: '203.0.113.20', network: 'public', direct: true },
      { ip: '2001:db8::20', network: 'public', direct: true },
      { ip: '203.0.113.21', network: 'public-alias', direct: true },
      { ip: '10.0.0.20', mac: '86:00:00:00:00:20', network: 'private:4711', direct: true },
      { ip: '10.0.0.21', mac: '86:00:00:00:00:20', network: 'private:4711', direct: true },
    ]);
    expect(http.calls.map((call) => call.options.query?.page)).toEqual([1, 2]);
  });

  it('creates with user data and a correlation label, then returns the server action', async () => {
    const http = new FakeHostingHttp((path, options) => {
      expect(path).toBe('/v1/servers');
      expect(options).toMatchObject({ method: 'POST' });
      return { server, action: { id: 77, status: 'running', resources: [{ id: 9, type: 'server' }] } };
    });
    const adapter = new HetznerHostingAdapter(connection, http);
    const request: HostingCreateRequest = {
      name: 'gateway-web',
      location: 'fsn1',
      size: 'cpx22',
      image: '100',
      marker: 'request-456',
      userData: '#cloud-config\npackages: []',
    };

    await expect(adapter.create(request)).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'running',
    });
    expect(http.calls[0]?.options.body).toEqual({
      name: 'gateway-web',
      location: 'fsn1',
      server_type: 'cpx22',
      image: '100',
      user_data: '#cloud-config\npackages: []',
      labels: { marker: 'request-456' },
    });
  });

  it('dispatches power and change-type actions once and reads action status without polling', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v1/actions/77')
        return { action: { id: 77, status: 'success', resources: [{ id: 9, type: 'server' }] } };
      if (path === '/v1/actions/78')
        return { action: { id: 78, status: 'completed', resources: [{ id: 9, type: 'server' }] } };
      if (path === '/v1/actions/79')
        return { action: { id: 79, status: 'succeeded', resources: [{ id: 9, type: 'server' }] } };
      if (path.endsWith('/actions/change_type'))
        return { action: { id: 77, status: 'running', resources: [{ id: 9, type: 'server' }] } };
      if (path.includes('/actions/'))
        return { action: { id: 77, status: 'running', resources: [{ id: 9, type: 'server' }] } };
      return null;
    });
    const adapter = new HetznerHostingAdapter(connection, http);

    await expect(adapter.action(resource(), { action: 'start' })).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'resize', size: 'cpx31', diskGb: 160 })).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'shutdown' })).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'reboot' })).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'running',
    });
    await expect(adapter.action(resource(), { action: 'delete' })).resolves.toEqual({
      id: null,
      resourceId: '9',
      status: 'succeeded',
    });
    await expect(adapter.operation('77', '9')).resolves.toEqual({
      id: '77',
      resourceId: '9',
      status: 'succeeded',
    });
    await expect(adapter.operation('78', '9')).resolves.toEqual({
      id: '78',
      resourceId: '9',
      status: 'unknown',
    });
    await expect(adapter.operation('79', '9')).resolves.toEqual({
      id: '79',
      resourceId: '9',
      status: 'unknown',
    });

    expect(http.calls.map((call) => call.path)).toEqual([
      '/v1/servers/9/actions/poweron',
      '/v1/servers/9/actions/change_type',
      '/v1/servers/9/actions/shutdown',
      '/v1/servers/9/actions/reboot',
      '/v1/servers/9',
      '/v1/actions/77',
      '/v1/actions/78',
      '/v1/actions/79',
    ]);
    expect(http.calls[0]?.options.body).toBeUndefined();
    expect(http.calls[1]?.options.body).toEqual({ server_type: 'cpx31', upgrade_disk: true });
  });

  it('includes the disk-upgrade choice for catalog-ID-only resize requests', async () => {
    const http = new FakeHostingHttp(() => ({
      action: { id: 77, status: 'running', resources: [{ id: 9, type: 'server' }] },
    }));
    const adapter = new HetznerHostingAdapter(connection, http);
    await adapter.action(resource(), { action: 'resize', size: '109' });
    expect(http.calls[0]?.options.body).toEqual({ server_type: 109, upgrade_disk: true });
  });

  it('keeps an explicit same-disk resize from growing the disk', async () => {
    const http = new FakeHostingHttp(() => ({
      action: { id: 77, status: 'running', resources: [{ id: 9, type: 'server' }] },
    }));
    const adapter = new HetznerHostingAdapter(connection, http);
    await adapter.action(resource(), { action: 'resize', size: 'cpx31', diskGb: resource().diskGb! });
    expect(http.calls[0]?.options.body).toEqual({ server_type: 'cpx31', upgrade_disk: false });
  });

  it('distinguishes definite resize rejection from unknown transport outcome', async () => {
    const rejection = new FakeHostingHttp(() => {
      throw new HostingProviderError(422, false, 'Invalid configuration');
    });
    await expect(
      new HetznerHostingAdapter(connection, rejection).action(resource(), { action: 'resize', size: '109' })
    ).rejects.toMatchObject({ code: 'HOSTING_RESIZE_REJECTED' });
    const uncertain = new FakeHostingHttp(() => {
      throw new HostingProviderError(502, true, 'Lost response');
    });
    await expect(
      new HetznerHostingAdapter(connection, uncertain).action(resource(), { action: 'resize', size: '109' })
    ).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('returns null only for provider 404 and rejects unsafe responses without payload leakage', async () => {
    const notFoundHttp = new FakeHostingHttp(() => {
      throw new HostingProviderError(404, false, 'Provider returned HTTP 404');
    });
    await expect(new HetznerHostingAdapter(connection, notFoundHttp).getResource('9')).resolves.toBeNull();

    const unsafeHttp = new FakeHostingHttp(() => ({ servers: 'not-an-array', provider_secret: 'do-not-leak' }));
    await expect(new HetznerHostingAdapter(connection, unsafeHttp).listResources()).rejects.toMatchObject({
      providerStatus: 502,
      message: 'Provider returned an unsafe response',
    });

    const rawErrorHttp = new FakeHostingHttp(() => {
      throw new Error('provider payload with secret');
    });
    await expect(new HetznerHostingAdapter(connection, rawErrorHttp).test()).rejects.toMatchObject({
      message: 'Provider request failed',
    });
  });

  it('does not expose unsupported finance methods', () => {
    const adapter = new HetznerHostingAdapter(connection, new FakeHostingHttp(() => ({ servers: [] })));
    expect('finance' in adapter).toBe(false);
  });

  it('marks malformed create and action replies as unknown outcome after POST', async () => {
    const http = new FakeHostingHttp((path) => {
      if (path === '/v1/servers' || path.includes('/actions/')) return {};
      return null;
    });
    const adapter = new HetznerHostingAdapter(connection, http);
    const request: HostingCreateRequest = {
      name: 'gateway-web',
      location: 'fsn1',
      size: 'cpx22',
      image: '100',
      marker: 'request-456',
      userData: '#cloud-config\npackages: []',
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
