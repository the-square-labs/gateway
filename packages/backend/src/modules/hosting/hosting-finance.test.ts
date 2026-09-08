import { describe, expect, it, vi } from 'vitest';
import { HostingFinanceService, safeHostingInvoice } from './hosting-finance.service.js';
import { HostingProviderError } from './hosting-http.js';

describe('hosting finance boundary', () => {
  it('rejects unavailable provider billing without a network request', async () => {
    const connectors = { get: vi.fn(async () => ({ capabilities: { finance: false } })), adapter: vi.fn() };
    const service = new HostingFinanceService({} as never, connectors as never, {} as never, {} as never, {} as never);
    await expect(service.get('account', { scopes: ['hosting:billing:view'] } as never)).rejects.toMatchObject({
      code: 'HOSTING_FINANCE_UNAVAILABLE',
    });
    expect(connectors.adapter).not.toHaveBeenCalled();
  });
  it('revokes detected billing access after provider permission changes', async () => {
    const connector = { capabilities: { finance: true } };
    const connectors = {
      get: vi.fn(async () => connector),
      adapter: () => ({
        finance: async () => {
          throw new HostingProviderError(403, false, 'Provider returned HTTP 403');
        },
      }),
      revokeFinance: vi.fn(async () => {}),
    };
    const service = new HostingFinanceService({} as never, connectors as never, {} as never, {} as never, {} as never);
    await expect(service.get('account', { scopes: ['hosting:billing:view'] } as never)).rejects.toMatchObject({
      code: 'HOSTING_FINANCE_UNAVAILABLE',
    });
    expect(connectors.revokeFinance).toHaveBeenCalledWith(connector);
  });
  it('uses provider-hosted invoice links without credentials or arbitrary redirects', () => {
    const invoice = { id: '1', status: 'unpaid', total: null, date: null };
    expect(safeHostingInvoice({ ...invoice, url: 'https://invapi.hostkey.com/?invoice=1' }).url).toBe(
      'https://invapi.hostkey.com/?invoice=1'
    );
    for (const url of [
      'javascript:alert(1)',
      'https://evil.test/pay',
      'https://invapi.hostkey.com:8443/pay',
      'https://secret@invapi.hostkey.com/',
      'https://invapi.hostkey.com/?token=secret',
    ])
      expect(safeHostingInvoice({ ...invoice, url }).url).toBeUndefined();
  });
  it('denies finance reads before touching connector credentials or provider API', async () => {
    const connectors = { get: vi.fn(), adapter: vi.fn() };
    const service = new HostingFinanceService({} as never, connectors as never, {} as never, {} as never, {} as never);
    const user = { id: 'u', scopes: ['nodes:details', 'integrations:hosting:manage'] };
    await expect(service.get('account', user as never)).rejects.toMatchObject({ code: 'HOSTING_ACCESS_DENIED' });
    expect(connectors.get).not.toHaveBeenCalled();
    expect(connectors.adapter).not.toHaveBeenCalled();
  });
  it('does not grant topup from finance read access or account management', async () => {
    const connectors = { get: vi.fn(), adapter: vi.fn() };
    const operations = { reserve: vi.fn() };
    const service = new HostingFinanceService(
      {} as never,
      connectors as never,
      operations as never,
      {} as never,
      {} as never
    );
    await expect(
      service.topup('account', { amount: '10.00', currency: 'USD', idempotencyKey: 'key', confirmed: true }, {
        id: 'u',
        scopes: ['hosting:billing:view', 'integrations:hosting:manage'],
      } as never)
    ).rejects.toMatchObject({ code: 'HOSTING_ACCESS_DENIED' });
    expect(operations.reserve).not.toHaveBeenCalled();
  });
});
