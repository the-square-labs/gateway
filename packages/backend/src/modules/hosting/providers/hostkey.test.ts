import { describe, expect, it, vi } from 'vitest';
import { HostingSettingsSchema } from '../hosting.schemas.js';
import type { HostingHttp } from '../hosting-http.js';
import { applyHostingImagePolicy } from '../hosting-image-policy.js';
import { HostkeyHostingAdapter } from './hostkey.js';

function fake(...responses: unknown[]) {
  const request = vi.fn();
  for (const response of responses) request.mockResolvedValueOnce(response);
  const http: HostingHttp = { request };
  return {
    adapter: new HostkeyHostingAdapter(
      {
        provider: 'hostkey',
        baseUrl: 'https://invapi.hostkey.com',
        token: 'secret',
        settings: HostingSettingsSchema.parse({}),
      },
      http
    ),
    request,
  };
}
const client = {
  result: 'success',
  client: { id: 123, credit: '150.50', currency_code: 'USD' },
  billing_location: 'whmcs_com',
};
const createInput = {
  name: 'Test Docker Node!',
  location: 'NL',
  size: '279',
  image: '219',
  marker: 'gw-f5057119-bd77-49b4-bd64-87885e152518',
  userData: '#!/bin/bash\necho bootstrap-private',
};
function createFixture(
  result: unknown,
  plans: unknown[] = [{ id: 25, active: 1, price: 0, currency_id: 0, locations: 'NL,RU,' }]
) {
  return fake(
    client,
    {
      result: 'OK',
      presets: [{ id: 279, name: 'vm.v2-pico', virtual: 1, locations: 'NL,RU', ram: 1, hdd: '40', monthly_usd: 6.47 }],
    },
    { result: 'OK', os_list: [{ id: 219, name: 'Debian 12' }] },
    { result: 'OK', traffic_plans: plans },
    result
  );
}

describe('HOSTKEY adapter verified envelope variants', () => {
  const orderInvoice = {
    result: 'OK',
    invoiceid: 900,
    userid: 123,
    status: 'Unpaid',
    total: '6.47',
    balance: '6.47',
    currencycode: 'USD',
    items: { item: [{ type: 'Hosting', relid: 456, description: `VM ${createInput.marker} (monthly)` }] },
  };
  it.each([
    orderInvoice,
    { result: 'OK', data: orderInvoice },
  ])('pays only the exact order invoice after durable authorization', async (invoice) => {
    const { adapter, request } = fake(client, invoice, { result: 'success', amount: '6.47' });
    const before = vi.fn(async (payment) => {
      expect(payment).toEqual({ invoiceId: '900', amount: '6.47', currency: 'USD' });
      expect(request.mock.calls.some(([, options]) => options.form.action === 'apply_credit')).toBe(false);
    });
    await adapter.payOrderInvoice('900', createInput.marker, { amount: '6.4700000000000000', currency: 'USD' }, before);
    expect(before).toHaveBeenCalledOnce();
    expect(request.mock.calls.at(-1)).toEqual([
      '/whmcs.php',
      { method: 'POST', readOnly: false, form: { action: 'apply_credit', invoice_id: '900', amount: '6.47' } },
    ]);
  });
  it.each([
    { invoiceid: 901 },
    { userid: 124 },
    { currencycode: 'EUR' },
    { total: '6.4700000000000001' },
    { balance: '6.48' },
    { balance: '-1' },
    { balance: 'NaN' },
    { status: 'Cancelled' },
    { items: { item: [{ type: 'AddFunds', description: createInput.marker }] } },
    { items: { item: [{ type: 'Hosting', description: `${createInput.marker}-other` }] } },
    { items: { item: [{ type: 'Hosting', description: 'unrelated VM' }] } },
    { items: { item: [...orderInvoice.items.item, { type: 'Hosting', description: 'other VM' }] } },
  ])('never pays a mismatched or closed invoice: %j', async (patch) => {
    const { adapter, request } = fake(client, { ...orderInvoice, ...patch });
    const before = vi.fn();
    await expect(
      adapter.payOrderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' }, before)
    ).rejects.toThrow();
    expect(before).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not pay with insufficient credit or after a failed durable fence', async () => {
    const insufficient = fake({ ...client, client: { ...client.client, credit: '6.46' } }, orderInvoice);
    const before = vi.fn();
    await expect(
      insufficient.adapter.payOrderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' }, before)
    ).rejects.toThrow('insufficient');
    expect(before).not.toHaveBeenCalled();
    const fenced = fake(client, orderInvoice);
    await expect(
      fenced.adapter.payOrderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' }, async () => {
        throw new Error('lost lease');
      })
    ).rejects.toThrow('lost lease');
    expect(fenced.request).toHaveBeenCalledTimes(2);
  });
  it('does not pay an already paid invoice and never replays a failed credit response', async () => {
    const paid = fake(client, { ...orderInvoice, status: 'Paid', balance: '0' });
    const before = vi.fn();
    await paid.adapter.payOrderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' }, before);
    expect(before).not.toHaveBeenCalled();
    const unknown = fake(client, orderInvoice, { result: 'unfamiliar' });
    await expect(
      unknown.adapter.payOrderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' }, async () => {})
    ).rejects.toThrow();
    expect(unknown.request.mock.calls.filter(([, options]) => options.form.action === 'apply_credit')).toHaveLength(1);
  });
  it.each([
    { userid: 124 },
    { currencycode: 'EUR' },
    { total: '6.48' },
    { items: { item: [{ type: 'Hosting', description: 'another order' }] } },
  ])('validates paid invoices too: %j', async (patch) => {
    const invoice = { ...orderInvoice, status: 'Paid', balance: '0', ...patch };
    await expect(
      fake(client, invoice).adapter.orderInvoice('900', createInput.marker, { amount: '6.47', currency: 'USD' })
    ).rejects.toThrow();
    await expect(
      fake(client, invoice).adapter.payOrderInvoice(
        '900',
        createInput.marker,
        { amount: '6.47', currency: 'USD' },
        vi.fn()
      )
    ).rejects.toThrow();
  });
  it('recovers only an exact unique invoice marker from a complete list', async () => {
    const { adapter, request } = fake(
      { result: 'success', totalresults: 2, invoices: [{ id: 899 }, { id: 900 }] },
      { ...orderInvoice, invoiceid: 899, items: { item: [{ type: 'Hosting', description: 'other VM' }] } },
      orderInvoice
    );
    expect(await adapter.findOrderInvoice(createInput.marker)).toBe('900');
    expect(request.mock.calls.every(([, options]) => options.readOnly)).toBe(true);
    const ambiguous = fake(
      { result: 'OK', totalresults: 2, invoices: { invoice: [{ id: 899 }, { id: 900 }] } },
      { ...orderInvoice, invoiceid: 899 },
      orderInvoice
    );
    await expect(ambiguous.adapter.findOrderInvoice(createInput.marker)).rejects.toThrow('multiple invoices');
    const partial = fake({ result: 'OK', totalresults: 2, invoices: [{ id: 900 }] });
    await expect(partial.adapter.findOrderInvoice(createInput.marker)).rejects.toThrow('incomplete');
    expect(partial.request).toHaveBeenCalledTimes(1);
  });
  it('keeps an accepted order without references unknown, not falsely running', async () => {
    const { adapter } = createFixture({ result: 'success' });
    expect((await adapter.create(createInput)).status).toBe('unknown');
  });
  it('builds an overview summary from credit and recurring contracts without invoice history', async () => {
    const { adapter, request } = fake(
      client,
      {
        result: 'OK',
        billing_status: 'Active',
        billing_cycle: 'Annually',
        billing_reccuring: '36.00',
        currencysuffix: 'USD',
      },
      {
        result: 'OK',
        billing_status: 'Active',
        billing_cycle: 'Monthly',
        billing_reccuring: '6.47',
        currencysuffix: 'USD',
      }
    );
    const summary = await adapter.accountSummary([{ remoteId: '1' }, { remoteId: '2' }] as any);
    expect(summary.balance).toMatchObject({ amount: '150.50', currency: 'USD' });
    expect(summary.monthlyExpenses).toMatchObject({ amount: '9.47', period: 'month' });
    expect(request.mock.calls.map(([, options]) => options.form.action)).toEqual([
      'get_client',
      'get_billing_data',
      'get_billing_data',
    ]);
  });
  it('keeps the balance but hides an incomplete recurring total', async () => {
    const { adapter } = fake(client, { result: -2, error: 'Permission denied' });
    const summary = await adapter.accountSummary([{ remoteId: '1' }] as any);
    expect(summary.balance?.amount).toBe('150.50');
    expect(summary.monthlyExpenses).toBeNull();
  });
  it.each([
    [],
    [{ id: 25, active: 1, price: 4, currency_id: 0, locations: 'NL' }],
    [{ id: 25, active: 0, price: 0, currency_id: 0, locations: 'NL' }],
    [{ id: 25, active: 1, price: 0, currency_id: 1, locations: 'NL' }],
    [{ id: 25, active: 1, price: 0, currency_id: 0, locations: 'US' }],
    [{ active: 1, price: 0, currency_id: 0, locations: 'NL' }],
  ])('does not order without a compatible free traffic plan: %j', async (...plans) => {
    const { adapter, request } = createFixture({ result: 'OK', id: 501 }, plans);
    await expect(adapter.create(createInput)).rejects.toThrow('without a surcharge');
    expect(request.mock.calls.some(([, options]) => options.form?.action === 'order_instance')).toBe(false);
  });
  it('reads numeric inventory IDs without mixing billing and EQ account identities', async () => {
    const { adapter, request } = fake(
      client,
      { result: 'OK', servers: [501, '502'] },
      { result: 'OK', server_data: { id: 501, ref_tableName: 'VPS' } },
      { result: 'OK', server_data: { id: 502, ref_tableName: 'VPS' } }
    );
    expect((await adapter.listResources()).resources.map((r) => r.remoteId)).toEqual(['501', '502']);
    expect(request.mock.calls[1][1].form).toEqual({ action: 'list' });
  });
  it.each([
    null,
    {},
    -1,
    '',
    'invalid',
    { id: 0 },
  ])('never treats malformed inventory as evidence of deletion: %j', async (entry) => {
    const { adapter } = fake(client, { result: 'OK', servers: [entry] });
    await expect(adapter.getResource('501')).rejects.toThrow('invalid resource identity');
  });
  it('preserves unfamiliar plain provider rejections instead of hiding their cause behind code -1', async () => {
    const { adapter } = createFixture({ result: -1, error: 'IPv4 amount must be specified' });
    await expect(adapter.create(createInput)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'HOSTKEY rejected eq/order_instance. Provider says: IPv4 amount must be specified',
    });
  });
  it.each([
    'Request rejected secret',
    'Request rejected abcdef1234567890abcdef1234567890',
    'Request rejected user@example.test',
    'Request rejected https://example.test/private',
    'Request rejected {"data":"private"}',
    'Request rejected\nprivate',
    'x'.repeat(301),
  ])('does not expose sensitive or structured provider diagnostics: %s', async (message) => {
    const { adapter } = createFixture({ result: -1, error: message });
    const error = await adapter.create(createInput).catch((error) => error);
    expect(error.message).not.toContain(message);
    expect(error.message).not.toContain('Provider says:');
  });
  it('uses the panel order contract and a compliant random password, without reinstall or billing aliases', async () => {
    const { adapter, request } = createFixture({ result: 'OK', id: 501, callback: 'task-1' });
    expect(await adapter.create(createInput)).toMatchObject({ id: 'task-1', resourceId: '501', status: 'running' });
    expect(request.mock.calls[3]).toEqual([
      '/traffic_plans.php',
      {
        method: 'GET',
        query: {
          action: 'list',
          location: 'NL',
          instance: '279',
        },
        readOnly: true,
      },
    ]);
    const [path, options] = request.mock.calls[4];
    expect(path).toBe('/eq.php');
    expect(options).toMatchObject({
      readOnly: false,
      form: {
        action: 'order_instance',
        preset: 'vm.v2-pico',
        location_name: 'NL',
        os_id: '219',
        deploy_period: 'monthly',
        traffic_plan: '25',
        post_install_script: createInput.userData,
        hostname: `test-docker-node-${createInput.marker}`,
      },
    });
    for (const key of ['id', 'preset_id', 'bill_period', 'disk_mirror']) expect(options.form).not.toHaveProperty(key);
    const password = options.form.root_pass;
    expect(password).toMatch(/^[a-zA-Z0-9%_+-]{8,30}$/);
    for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/, /[%_+-]/]) expect(password).toMatch(pattern);
    const other = createFixture({ result: 'OK', id: 502 });
    await other.adapter.create(createInput);
    expect(other.request.mock.calls[4][1].form.root_pass).not.toBe(password);
  });
  it.each([
    { result: 'success', action: 'order_instance', invoiceid: 900, redirect: '/invoice' },
    { result: 'OK', deploy_status: 'awaiting_payment', invoice_id: 900 },
    { result: 'success', invoice_id: 900 },
    { result: 'OK', data: { invoice_id: 900 } },
  ])('retains the invoice without inventing a VM ID or reordering', async (response) => {
    const { adapter, request } = createFixture(response);
    expect(await adapter.create(createInput)).toEqual({
      id: null,
      resourceId: undefined,
      status: 'awaiting_payment',
      invoiceId: '900',
    });
    expect(request.mock.calls.filter(([, options]) => options.form?.action === 'order_instance')).toHaveLength(1);
  });
  it.each([
    ['Invalid preset 279', 'tariff'],
    ['Invalid root password: private-password', 'password'],
    ['Insufficient funds', 'insufficient funds'],
    ['Invalid deploy_period', 'billing period'],
  ])('reports a safe actionable rejection for %s', async (message, expected) => {
    const { adapter } = createFixture({ result: -1, error: message });
    const error = await adapter.create(createInput).catch((error) => error);
    expect(error).toMatchObject({ outcomeUnknown: false });
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain('private-password');
  });
  it('keeps unexpected successful-looking write envelopes uncertain', async () => {
    const { adapter, request } = createFixture({ result: { id: 501 }, token: 'secret' });
    await expect(adapter.create(createInput)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(request.mock.calls.filter(([, options]) => options.form?.action === 'order_instance')).toHaveLength(1);
  });
  it('does not release the paid-order fence when an error response also identifies a resource or invoice', async () => {
    for (const partial of [{ id: 501 }, { invoiceid: 900 }, { callback: 'task-1' }, { context: { id: 501 } }]) {
      const { adapter } = createFixture({ result: 'Fail', error: 'Deployment failed', ...partial });
      await expect(adapter.create(createInput)).rejects.toMatchObject({ outcomeUnknown: true });
    }
  });
  it('reads the real show shape and keeps credentials out of resource snapshots', async () => {
    const { adapter } = fake(
      client,
      { result: 'OK', servers: [{ id: 501 }] },
      {
        result: 'OK',
        server_data: { id: 501, ref_tableName: 'VPS', Condition_Component: 'rent', power_status: 'on' },
        IP: [{ IP: '8.8.8.8', MAC: 'aa:bb:cc:dd:ee:ff' }],
        location: { dc_location: 'NL' },
        interfaces: [{ mac: 'aa:bb:cc:dd:ee:ff', IsMain: 1 }],
        tags: [
          { tag: 'hostname', value: `worker-${createInput.marker}` },
          { tag: 'password', value: 'never-expose-this' },
        ],
      }
    );
    const inventory = await adapter.listResources();
    expect(inventory.resources[0]).toMatchObject({
      name: `worker-${createInput.marker}`,
      marker: createInput.marker,
      location: 'NL',
      powerState: 'running',
      incarnation: 'mac:aa:bb:cc:dd:ee:ff',
      addresses: [{ ip: '8.8.8.8', mac: 'aa:bb:cc:dd:ee:ff' }],
    });
    expect(JSON.stringify(inventory)).not.toContain('never-expose-this');
  });
  it('does not equate a known resource type change or incomplete inventory with deletion', async () => {
    const existing = fake(
      client,
      { result: 'OK', servers: [{ id: 501 }] },
      { result: 'OK', server_data: { id: 501, ref_tableName: 'Unknown' }, tags: [{ tag: 'hostname', value: 'worker' }] }
    );
    expect(await existing.adapter.getResource('501')).toMatchObject({ remoteId: '501' });
    const incomplete = fake(client, { result: 'OK' });
    await expect(incomplete.adapter.getResource('501')).rejects.toThrow('incomplete');
    const absent = fake(client, { result: 'OK', servers: [] });
    expect(await absent.adapter.getResource('501')).toBeNull();
  });
  it('rejects conflicting show identities and hostnames instead of linking the wrong VM', async () => {
    const mismatch = fake(client, { result: 'OK', servers: [{ id: 501 }] }, { result: 'OK', server_data: { id: 502 } });
    await expect(mismatch.adapter.getResource('501')).rejects.toThrow('different resource identity');
    const names = fake(
      client,
      { result: 'OK', servers: [{ id: 501 }] },
      {
        result: 'OK',
        server_data: { id: 501 },
        tags: [
          { tag: 'hostname', value: 'one' },
          { tag: 'hostname', value: 'two' },
        ],
      }
    );
    await expect(names.adapter.getResource('501')).rejects.toThrow('conflicting VM hostnames');
  });
  it('reads the VM identity from a completed callback without exposing its scope', async () => {
    const { adapter } = fake({ result: 'OK', context: { id: 501 }, scope: { password: 'secret' } });
    expect(await adapter.operation('task-1')).toEqual({ id: 'task-1', resourceId: '501', status: 'succeeded' });
  });
  it('does not misclassify a missing callback as a confirmed failed order', async () => {
    const { adapter } = fake({ result: -1, error: 'Callback key not found' });
    await expect(adapter.operation('expired-key')).rejects.toBeInstanceOf(Error);
  });
  it('recognizes plain HOSTKEY x86 OS names without admitting application suffixes or conflicting architecture', async () => {
    const { adapter } = fake(
      client,
      { result: 'OK', presets: [] },
      {
        result: 'OK',
        os_list: [
          { id: 1, name: 'Ubuntu 24.04 LTS x64' },
          { id: 2, name: 'Debian 13 amd64' },
          { id: 3, name: 'Fedora Cloud 44 x86_64' },
          { id: 4, name: 'Ubuntu 24.04' },
          { id: 5, name: 'Ubuntu 24.04 LTS x64 NVIDIA' },
          { id: 6, name: 'Ubuntu 22.04 x64' },
          { id: 7, name: 'Alpine 3.22 x64' },
          { id: 8, name: 'Debian 13 arm64' },
          { id: 9, name: 'Ubuntu 24.04 Desktop' },
          { id: 10, name: 'Debian 12', architecture: 'arm64' },
          { id: 11, name: 'Ubuntu 22.04', arch: 'unknown' },
          { id: 12, name: 'Debian 12' },
          { id: 13, name: 'Ubuntu 22.04' },
        ],
      }
    );
    const catalog = applyHostingImagePolicy(await adapter.catalog(), 'hostkey');
    expect(catalog.images.map((image) => image.id)).toEqual(['1', '2', '3', '4', '6', '12', '13']);
    expect(catalog.images.every((image) => image.supportedRoles?.includes('relay'))).toBe(true);
  });
  it('normalizes live CSV regions, GiB RAM, GB disk and regional prices with monthly fallback', async () => {
    const { adapter } = fake(
      client,
      {
        result: 'OK',
        presets: [
          {
            id: 108,
            name: 'vm.pico',
            virtual: 1,
            cpu: 1,
            ram: 1,
            hdd: '40',
            locations: 'NL, RU,US,NL,',
            monthly_usd: 3.39,
            price: { NL: { USD: -1 }, RU: { USD: 4.5 }, US: { USD: 0 } },
          },
          { id: 109, name: 'vm.nano', virtual: 1, ram: 2, hdd: 60, locations: ['NL', ' FI ', ''], price: { USD: 6 } },
        ],
      },
      { result: 'OK', os_list: [{ id: 219, name: 'Debian 12' }] }
    );
    const catalog = await adapter.catalog();
    expect(catalog.locations.map((region) => region.id)).toEqual(['NL', 'RU', 'US', 'FI']);
    expect(catalog.locations[0]).toEqual({ id: 'NL', name: 'Netherlands (NL)' });
    expect(catalog.sizes[0]).toMatchObject({
      cpu: 1,
      memoryMb: 1024,
      diskGb: 40,
      architecture: 'x64',
      locations: ['NL', 'RU', 'US'],
      price: { amount: '3.39', currency: 'USD' },
      locationPrices: { NL: { amount: '3.39' }, RU: { amount: '4.5' }, US: { amount: '0' } },
    });
    expect(catalog.sizes[1]).toMatchObject({
      memoryMb: 2048,
      diskGb: 60,
      locations: ['NL', 'FI'],
      locationPrices: { NL: { amount: '6' }, FI: { amount: '6' } },
    });
  });
  it('never advertises a negative sentinel or invents a price for an unknown currency', async () => {
    const { adapter } = fake(
      client,
      { result: 'OK', presets: [{ id: 1, virtual: 1, locations: 'NL', price: { NL: { USD: -1 } }, monthly_usd: -1 }] },
      { result: 'OK', os_list: [] }
    );
    expect((await adapter.catalog()).sizes[0]).toMatchObject({ price: undefined, locationPrices: {} });
    const unknown = fake(
      { ...client, client: { id: 123, currency_code: 'GBP' } },
      { result: 'OK', presets: [{ id: 1, virtual: 1, locations: 'NL', monthly_com: 5, monthly_usd: 6 }] },
      { result: 'OK', os_list: [] }
    );
    expect((await unknown.adapter.catalog()).sizes[0]?.price).toBeUndefined();
  });
  it('uses billing account identity, not token or email', async () => {
    const { adapter } = fake(client, { result: 'OK', servers: [] });
    expect(await adapter.test()).toMatchObject({ authority: 'hostkey:whmcs_com:123' });
  });
  it('connects a VM-only key through auth/info while retaining the account identity guard', async () => {
    const { adapter, request } = fake(
      { code: -1, message: 'Access denied' },
      {
        result: 'OK',
        whmcs_id: 123,
        customer_id: 123,
        whmcs_location: 'whmcs_com',
        data: { username: 'vm-key-user' },
      },
      { result: 'OK', servers: [] }
    );
    await expect(adapter.test()).resolves.toMatchObject({
      authority: 'hostkey:whmcs_com:123',
      name: 'vm-key-user',
      capabilities: {
        create: { available: true },
        finance: { available: false, reasonCode: 'permission_denied' },
        topup: { available: false, reasonCode: 'permission_denied' },
      },
    });
    expect(request.mock.calls).toEqual([
      ['/whmcs.php', { method: 'POST', form: { action: 'get_client' }, readOnly: true }],
      ['/auth.php', { method: 'POST', form: { action: 'info' }, readOnly: true }],
      ['/eq.php', { method: 'POST', form: { action: 'list' }, readOnly: true }],
    ]);
  });
  it('keeps the VM catalog available when WHMCS access is absent', async () => {
    const { adapter } = fake(
      { code: -1, message: 'Access denied' },
      { result: 'OK', whmcs_id: 123, customer_id: 123, data: { username: 'vm-key-user' } },
      { result: 'OK', presets: [] },
      { result: 'OK', os_list: [] }
    );
    await expect(adapter.catalog()).resolves.toEqual({ locations: [], sizes: [], images: [] });
  });
  it('classifies documented failure envelopes without echoing the provider message', async () => {
    const denied = fake(
      { result: 'Fail', code: -1, message: 'Access denied for token=secret' },
      { code: -1, message: 'Invalid token token=secret' }
    );
    await expect(denied.adapter.test()).rejects.toMatchObject({
      providerStatus: 403,
      message: 'HOSTKEY denied access to auth/info',
    });

    const rejected = fake({ code: -1, message: 'EQ/list: invalid server id token=secret' });
    await expect(rejected.adapter.operation('callback')).resolves.toMatchObject({
      status: 'failed',
      error: expect.not.stringContaining('secret'),
    });
  });
  it('recognizes numeric result and error access denials from the live API', async () => {
    const denied = fake(
      { result: -1, error: 'Access denied for token=secret' },
      { result: -2, error: 'Invalid token token=secret' }
    );
    await expect(denied.adapter.test()).rejects.toMatchObject({
      providerStatus: 403,
      message: 'HOSTKEY denied access to auth/info',
    });
  });
  it('accepts the documented callback pending state only while polling a callback', async () => {
    const pending = fake({ result: 'Not ready' });
    await expect(pending.adapter.operation('callback')).resolves.toMatchObject({ status: 'running' });

    const unexpected = fake({ result: 'Not ready' });
    await expect(unexpected.adapter.test()).rejects.toMatchObject({ providerStatus: 400 });
  });
  it('reads authoritative client.credit and never sums credit history as balance', async () => {
    const { adapter, request } = fake(
      client,
      { result: 'success', invoices: { invoice: [{ id: 1, status: 'Paid', total: '10.50', date: '2026-09-01' }] } },
      { result: 'OK', transactions: [] }
    );
    expect(await adapter.finance()).toMatchObject({
      balance: { amount: '150.50', currency: 'USD', estimated: false },
      invoices: [{ id: '1', status: 'paid' }],
    });
    expect(request.mock.calls.some(([, opts]) => opts.form.action === 'getcredits')).toBe(false);
  });
  it('represents an unavailable balance as null, not zero', async () => {
    const { adapter } = fake(
      { ...client, client: { id: 123, currency_code: 'USD' } },
      { result: 'OK', invoices: [] },
      { result: 'OK', transactions: [] }
    );
    expect(await adapter.finance()).toMatchObject({ balance: null, unavailableReason: expect.any(String) });
  });
  it('accepts numeric and object topup invoices with safe external account links', async () => {
    const first = fake(client, { result: 'OK', invoice: 456 });
    expect(await first.adapter.topup('20.00', 'USD', 'gw-intent')).toMatchObject({
      id: '456',
      status: 'unpaid',
      total: { amount: '20.00', currency: 'USD' },
      url: 'https://invapi.hostkey.com/?invoice=456',
    });
    expect(first.request.mock.calls[1]).toMatchObject([
      '/whmcs.php',
      { method: 'POST', form: { action: 'create_addfunds', amount: '20.00', subscribe: false } },
    ]);
    const second = fake(client, {
      result: 'OK',
      invoice: {
        id: 457,
        status: 'Unpaid',
        amount: '20.00',
        currency_code: 'USD',
        payment_html: '<script>steal()</script>',
      },
    });
    expect(JSON.stringify(await second.adapter.topup('20.00', 'USD', 'gw-intent'))).not.toContain('script');
  });
  it('checks currency before creating any invoice and never retries malformed mutation results', async () => {
    const mismatch = fake(client);
    await expect(mismatch.adapter.topup('20.00', 'EUR', 'gw-intent')).rejects.toMatchObject({
      code: 'HOSTING_CURRENCY_CHANGED',
    });
    expect(mismatch.request).toHaveBeenCalledTimes(1);
    const unknown = fake(client, {});
    await expect(unknown.adapter.topup('20.00', 'USD', 'gw-intent')).rejects.toMatchObject({ outcomeUnknown: true });
    expect(unknown.request).toHaveBeenCalledTimes(2);
  });
  it('does not label rented server status as running, or expose raw credentials from show', async () => {
    const { adapter } = fake(
      client,
      { result: 'OK', servers: [{ id: 1, virtual: 1, status: 'rented' }] },
      {
        result: 'OK',
        server_data: {
          id: 1,
          type: 'VM',
          status: 'rented',
          hostname: 'node',
          root_pass: 'secret',
          ip: [{ IP: '8.8.8.8' }],
        },
        interfaces: [{ mac: 'aa:bb:cc:dd:ee:ff', IsMain: true }],
      }
    );
    const inventory = await adapter.listResources();
    expect(inventory.resources[0]).toMatchObject({ powerState: 'unknown', incarnation: 'mac:aa:bb:cc:dd:ee:ff' });
    expect(JSON.stringify(inventory)).not.toContain('secret');
  });
  it('returns the complete account-scoped VM inventory even when a connector has legacy resource IDs', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce({
        result: 'OK',
        servers: [
          { id: 1, virtual: 1 },
          { id: 2, virtual: 1 },
        ],
      })
      .mockResolvedValueOnce({ result: 'OK', server_data: { id: 1, type: 'VM', hostname: 'one' }, interfaces: [] })
      .mockResolvedValueOnce({ result: 'OK', server_data: { id: 2, type: 'VM', hostname: 'two' }, interfaces: [] });
    const adapter = new HostkeyHostingAdapter(
      {
        provider: 'hostkey',
        baseUrl: 'https://invapi.hostkey.com',
        token: 'secret',
        settings: HostingSettingsSchema.parse({ resourceIds: ['1'] }),
      },
      { request }
    );
    await expect(adapter.listResources()).resolves.toMatchObject({
      resources: [{ remoteId: '1' }, { remoteId: '2' }],
    });
  });
  it('rejects partial/invalid inventory instead of claiming every resource vanished', async () => {
    const { adapter } = fake(client, { result: 'OK' });
    await expect(adapter.listResources()).rejects.toMatchObject({ providerStatus: 502 });
  });
  it('keeps callback errors redacted', async () => {
    const { adapter } = fake({ result: 'Fail', message: 'token=secret' });
    await expect(adapter.operation('callback')).resolves.toMatchObject({
      status: 'failed',
      error: expect.not.stringContaining('secret'),
    });
  });
});
