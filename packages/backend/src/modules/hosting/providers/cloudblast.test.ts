import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import { applyHostingImagePolicy } from '../hosting-image-policy.js';
import type { HostingConnection, HostingResourceSnapshot } from '../hosting-provider.types.js';
import { CloudBlastHostingAdapter } from './cloudblast.js';

type RequestHandler = (path: string, options: HostingRequestOptions) => unknown | Promise<unknown>;

class FakeHostingHttp implements HostingHttp {
  readonly calls: Array<{ path: string; options: HostingRequestOptions }> = [];
  constructor(private readonly handler: RequestHandler) {}
  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    this.calls.push({ path, options });
    return (await this.handler(path, options)) as T;
  }
}

const connection: HostingConnection = {
  provider: 'cloudblast',
  baseUrl: 'https://console.cloudblast.io',
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

const SERVER = '0a1b2c3d-1111-4222-8333-444455556666';
const OTHER = '0a1b2c3d-7777-4888-9999-aaaabbbbcccc';
const GIB = 1024 ** 3;
const meta = (page = 1, last = 1) => ({ meta: { current_page: page, last_page: last, per_page: 25, total: 1 } });
const server = (uuid = SERVER) => ({
  id: 42,
  uuid,
  uuid_short: uuid.slice(0, 8),
  name: 'gateway-web',
  hostname: 'gateway-web.example.com',
  status: null,
  cpu: 2,
  memory: 4 * GIB,
  disk: 80 * GIB,
  created_at: '2026-09-01T10:00:00+00:00',
  ip_addresses: [
    { address: '203.0.113.20', type: 'ipv4', gateway: '203.0.113.1', cidr: 24, rdns: null, reserved: false },
    { address: '2001:db8::20', type: 'ipv6', gateway: '2001:db8::1', cidr: 64, rdns: null, reserved: false },
  ],
});
const detail = (uuid = SERVER) => ({
  data: {
    ...server(uuid),
    root_password: 'never-persist-me',
    password_status: 'ready',
    plan: { id: 7, name: 'Cloud M', monthly_price: 9.99, hourly_price: 0.015 },
    operating_system: 'Ubuntu 24.04 LTS',
  },
});
const running = { data: { state: 'running', power_task: null, server_status: null } };

function inventoryHttp(status: unknown = running) {
  return new FakeHostingHttp((path, options) => {
    if (path === '/api/v2/servers') return { data: [server()], ...meta(Number(options.query?.page), 1) };
    if (path === `/api/v2/servers/${SERVER}`) return detail();
    if (path === `/api/v2/servers/${SERVER}/status`) return status;
    throw new Error(`Unexpected ${path}`);
  });
}

async function resource(http = inventoryHttp()): Promise<HostingResourceSnapshot> {
  return (await new CloudBlastHostingAdapter(connection, http).getResource(SERVER))!;
}

describe('CloudBlastHostingAdapter', () => {
  it('identifies the account by its numeric ID and declares creation and resizing unsupported', async () => {
    const http = new FakeHostingHttp((path) =>
      path === '/api/v2/account'
        ? { data: { id: 1001, name: 'Ada', surname: 'Ops', email: 'ops@example.com', credit: 42.5 } }
        : { data: [], ...meta() }
    );
    const account = await new CloudBlastHostingAdapter(connection, http).test();
    expect(account.authority).toBe('cloudblast:1001');
    expect(account.name).toBe('ops@example.com');
    expect(account.capabilities.create).toMatchObject({ available: false, reasonCode: 'unsupported' });
    expect(account.capabilities.create.reason).toContain('no user data');
    expect(account.capabilities.resize.available).toBe(false);
    expect(account.capabilities.finance.available).toBe(true);
    expect(account.capabilities.topup.available).toBe(false);
    expect(account.capabilities.start.available).toBe(true);
    expect(http.calls.map((call) => call.path)).toEqual(['/api/v2/account', '/api/v2/servers']);
  });

  it('normalizes byte sizes, addresses, plan price and live power state without keeping credentials', async () => {
    const http = new FakeHostingHttp((path, options) => {
      if (path === '/api/v2/servers') {
        const page = Number(options.query?.page);
        return { data: [server(page === 1 ? SERVER : OTHER)], ...meta(page, 2) };
      }
      if (path.endsWith('/status'))
        return path.includes(OTHER) ? { data: { state: 'stopped', power_task: null, server_status: null } } : running;
      return detail(path.includes(OTHER) ? OTHER : SERVER);
    });
    const inventory = await new CloudBlastHostingAdapter(connection, http).listResources();
    expect(inventory.complete).toBe(true);
    expect(inventory.resources.map((item) => [item.remoteId, item.powerState])).toEqual([
      [SERVER, 'running'],
      [OTHER, 'stopped'],
    ]);
    expect(inventory.resources[0]).toMatchObject({
      kind: 'vm',
      name: 'gateway-web',
      cpu: 2,
      memoryMb: 4096,
      diskGb: 80,
      sizeId: '7',
      incarnation: `uuid:${SERVER}`,
      price: { amount: '9.99', currency: 'EUR', estimated: true, period: 'month' },
      providerUrl: `https://console.cloudblast.io/api/v2/servers/${SERVER}`,
      addresses: [
        { ip: '203.0.113.20', network: 'public', direct: true },
        { ip: '2001:db8::20', network: 'public', direct: true },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain('never-persist-me');
  });

  it('refuses an inventory page without pagination metadata instead of assuming it is complete', async () => {
    const http = new FakeHostingHttp(() => ({ data: [server()] }));
    await expect(new CloudBlastHostingAdapter(connection, http).listResources()).rejects.toBeInstanceOf(
      HostingProviderError
    );
  });

  it('reports a missing server as absent and other failures as errors', async () => {
    const missing = new FakeHostingHttp(() => {
      throw new HostingProviderError(404, false, 'missing');
    });
    await expect(new CloudBlastHostingAdapter(connection, missing).getResource(SERVER)).resolves.toBeNull();
    const failing = new FakeHostingHttp(() => {
      throw new HostingProviderError(500, false, 'down');
    });
    await expect(new CloudBlastHostingAdapter(connection, failing).getResource(SERVER)).rejects.toThrow('down');
  });

  it('maps pending power tasks to transitional power states', async () => {
    const stopping = await resource(
      inventoryHttp({
        data: { state: 'running', power_task: { action: 'shutdown', status: 'pending', state: 'shutting_down' } },
      })
    );
    expect(stopping.powerState).toBe('stopping');
    const starting = await resource(
      inventoryHttp({
        data: { state: 'stopped', power_task: { action: 'start', status: 'pending', state: 'starting' } },
      })
    );
    expect(starting.powerState).toBe('starting');
  });

  it('sends power actions once and polls the matching task through real-time status', async () => {
    let status: unknown = {
      data: { state: 'running', power_task: { action: 'restart', status: 'pending', upid: 'UPID:node1:0001' } },
    };
    const http = new FakeHostingHttp((path, options) => {
      if (path === `/api/v2/servers/${SERVER}/actions` && options.method === 'POST')
        return {
          data: { action: 'restart', status: 'initiated', task: { status: 'pending', upid: 'UPID:node1:0001' } },
        };
      if (path === `/api/v2/servers/${SERVER}/status`) return status;
      return detail();
    });
    const adapter = new CloudBlastHostingAdapter(connection, http);
    const vm = await adapter.getResource(SERVER);
    const task = await adapter.action(vm!, { action: 'reboot' });
    expect(task).toEqual({ id: 'power:restart:UPID:node1:0001', resourceId: SERVER, status: 'running' });
    expect(http.calls.find((call) => call.options.method === 'POST')?.options.body).toEqual({ action: 'restart' });
    await expect(adapter.operation(task.id!, SERVER)).resolves.toMatchObject({ status: 'running' });
    status = { data: { state: 'running', power_task: null, server_status: null } };
    await expect(adapter.operation(task.id!, SERVER)).resolves.toMatchObject({ status: 'succeeded' });
    status = {
      data: { state: 'running', power_task: { action: 'restart', status: 'failed', upid: 'UPID:node1:0001' } },
    };
    await expect(adapter.operation(task.id!, SERVER)).resolves.toMatchObject({ status: 'failed' });
    status = {
      data: { state: 'running', power_task: { action: 'shutdown', status: 'pending', upid: 'UPID:node1:0002' } },
    };
    await expect(adapter.operation(task.id!, SERVER)).resolves.toMatchObject({ status: 'unknown' });
    await expect(adapter.operation('power:start:', SERVER)).resolves.toMatchObject({ status: 'unknown' });
  });

  it('reports a rejected power task and marks an unreadable mutation response as uncertain', async () => {
    let payload: unknown = { data: { task: { status: 'failed', message: 'private node detail' } } };
    const http = new FakeHostingHttp((path, options) =>
      options.method === 'POST' ? payload : path.endsWith('/status') ? running : detail()
    );
    const adapter = new CloudBlastHostingAdapter(connection, http);
    const vm = (await adapter.getResource(SERVER))!;
    const failed = await adapter.action(vm, { action: 'shutdown' });
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).not.toContain('private');
    payload = 'not-json-object';
    await expect(adapter.action(vm, { action: 'start' })).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('deletes without re-sending and rejects unsupported actions without provider IO', async () => {
    const http = new FakeHostingHttp((path, options) =>
      options.method === 'DELETE' ? null : path.endsWith('/status') ? running : detail()
    );
    const adapter = new CloudBlastHostingAdapter(connection, http);
    const vm = (await adapter.getResource(SERVER))!;
    const before = http.calls.length;
    for (const action of ['resize', 'recover'] as const)
      await expect(adapter.action(vm, { action, size: '8' })).rejects.toMatchObject({
        code: 'HOSTING_ACTION_UNSUPPORTED',
      });
    await expect(adapter.create()).rejects.toBeInstanceOf(AppError);
    await expect(adapter.validateCreate()).rejects.toMatchObject({ code: 'HOSTING_ACTION_UNSUPPORTED' });
    expect(http.calls).toHaveLength(before);
    await expect(adapter.action(vm, { action: 'delete' })).resolves.toEqual({
      id: null,
      resourceId: SERVER,
      status: 'succeeded',
    });
    expect(http.calls.at(-1)).toMatchObject({ path: `/api/v2/servers/${SERVER}`, options: { method: 'DELETE' } });
    expect(http.calls.at(-1)?.options.query).toBeUndefined();
  });

  it('builds a stock-aware catalog per location with EUR plan prices', async () => {
    const http = new FakeHostingHttp((path, options) => {
      if (path === '/api/v2/locations')
        return {
          data: [
            { id: 1, short_code: 'AMS1', description: 'Amsterdam, Netherlands', out_of_stock: false },
            { id: 2, short_code: 'FRA1', description: 'Frankfurt, Germany', out_of_stock: false },
          ],
        };
      if (path === '/api/v2/plans') {
        const plan = { id: 7, name: 'Cloud M', cpu: 2, memory: 4 * GIB, disk: 80 * GIB, monthly_price: 9.99 };
        const available = options.query?.location_id === 1;
        return {
          data: [
            { ...plan, available },
            { ...plan, id: 8, name: 'Cloud L', available: true },
          ],
          ...meta(),
        };
      }
      if (path === '/api/v2/locations/1/templates')
        return {
          data: [
            { slug: 'ubuntu-24-04', name: 'Ubuntu 24.04 LTS', group_name: 'Ubuntu' },
            { slug: 'windows-2022', name: 'Windows Server 2022', group_name: 'Windows' },
          ],
        };
      if (path === '/api/v2/locations/2/templates')
        return { data: [{ slug: 'ubuntu-24-04', name: 'Ubuntu 24.04 LTS', group_name: 'Ubuntu' }] };
      throw new Error(`Unexpected ${path}`);
    });
    const catalog = await new CloudBlastHostingAdapter(connection, http).catalog();
    expect(catalog.locations).toEqual([
      { id: '1', name: 'Amsterdam, Netherlands (AMS1)' },
      { id: '2', name: 'Frankfurt, Germany (FRA1)' },
    ]);
    const medium = catalog.sizes.find((size) => size.id === '7');
    expect(medium).toMatchObject({ cpu: 2, memoryMb: 4096, diskGb: 80, locations: ['1'] });
    expect(medium?.locationPrices).toEqual({
      '1': { amount: '9.99', currency: 'EUR', estimated: true, period: 'month' },
    });
    expect(catalog.sizes.find((size) => size.id === '8')?.locations).toEqual(['1', '2']);
    expect(catalog.images.find((image) => image.id === 'ubuntu-24-04')).toMatchObject({
      locations: ['1', '2'],
      operatingSystem: { distribution: 'ubuntu', version: '24.04' },
    });
    expect(catalog.images.find((image) => image.id === 'windows-2022')?.operatingSystem).toBeUndefined();
    // Templates declare no architecture, so none are admitted for automatic installation.
    expect(applyHostingImagePolicy(catalog, 'cloudblast').images).toEqual([]);
  });

  it('reads the EUR credit balance, paginated invoices and estimated monthly VM expenses', async () => {
    const http = new FakeHostingHttp((path, options) => {
      if (path === '/api/v2/account') return { data: { id: 1001, credit: -3.5 } };
      if (path === '/api/v2/account/invoices')
        return {
          data: [{ id: 42, status: 'paid', total: 29.99, created_at: '2026-09-01T00:00:00+00:00' }],
          ...meta(Number(options.query?.page), 2),
        };
      throw new Error(`Unexpected ${path}`);
    });
    const adapter = new CloudBlastHostingAdapter(connection, http);
    const finance = await adapter.finance();
    expect(finance.balance).toEqual({ amount: '-3.5', currency: 'EUR', estimated: false });
    expect(finance.invoices).toEqual([
      {
        id: '42',
        status: 'paid',
        total: { amount: '29.99', currency: 'EUR', estimated: false },
        date: '2026-09-01T00:00:00+00:00',
      },
    ]);
    expect(finance.nextCursor).toBe('2');
    expect((await adapter.finance('2')).nextCursor).toBeUndefined();
    await expect(adapter.finance('0')).rejects.toBeInstanceOf(HostingProviderError);
    const vm = await resource();
    const summary = await adapter.accountSummary([vm, { ...vm, remoteId: OTHER }]);
    expect(summary.balance?.amount).toBe('-3.5');
    expect(summary.monthlyExpenses).toMatchObject({ amount: '19.98', currency: 'EUR', period: 'month' });
  });
});
