import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/created-resource-permissions.js', () => ({
  grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
}));

import { hostingOperations, hostingResources, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { HostingProvisionInput } from './hosting.schemas.js';
import { HostingProviderError } from './hosting-http.js';
import type { HostingOperationRow } from './hosting-operations.service.js';
import {
  type HostingCatalog,
  type HostingCreateRequest,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from './hosting-provider.types.js';
import { assertHostingQuote, HostingProvisioningService } from './hosting-provisioning.service.js';

const input: HostingProvisionInput = {
  connectorId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
  role: 'docker',
  name: 'worker',
  location: 'eu',
  size: 'small',
  image: 'debian',
  confirmedPrice: { amount: '6', currency: 'USD' },
};
const catalog: HostingCatalog = {
  locations: [{ id: 'eu', name: 'EU' }],
  images: [
    { id: 'debian', name: 'Debian', operatingSystem: { distribution: 'debian', version: '13' }, architecture: 'x64' },
  ],
  sizes: [{ id: 'small', name: 'Small', price: { amount: '6', currency: 'USD', estimated: true } }],
};

it('accepts an explicit Relay quote on compatible cloud images without weakening price confirmation', () => {
  expect(() =>
    assertHostingQuote({ ...input, role: 'relay', relayAddress: 'relay.example.test' }, catalog, false)
  ).not.toThrow();
  expect(() => assertHostingQuote({ ...input, role: 'relay', confirmedPrice: undefined }, catalog, false)).toThrow();
});
it('compares accepted catalog prices exactly, including Hetzner precision', () => {
  const preciseCatalog = {
    ...catalog,
    sizes: [{ ...catalog.sizes[0], price: { amount: '5.9900000000000000', currency: 'USD', estimated: true } }],
  };
  expect(() =>
    assertHostingQuote({ ...input, confirmedPrice: { amount: '5.99', currency: 'USD' } }, preciseCatalog, false)
  ).not.toThrow();
  expect(() =>
    assertHostingQuote(
      { ...input, confirmedPrice: { amount: '5.9900000000000001', currency: 'USD' } },
      preciseCatalog,
      false
    )
  ).toThrow('current price');
});
const actor = {
  id: 'actor',
  scopes: [
    'integrations:hosting:view',
    'hosting:resources:create',
    'hosting:resources:recover',
    'nodes:create',
    'nodes:config:edit',
  ],
  isBlocked: false,
  isDeleted: false,
} as User;
const snapshot: HostingResourceSnapshot = {
  remoteId: '250',
  kind: 'vm',
  name: 'worker',
  location: 'eu',
  powerState: 'running',
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  addresses: [],
  incarnation: 'smbios:unique',
  observedAt: new Date().toISOString(),
  capabilities: hostingCapabilities({ bootstrap: true }),
};

function runner(
  patch: Partial<HostingOperationRow> = {},
  allocation = { held: false, rows: [] as HostingOperationRow[] },
  createPatch: Partial<HostingCreateRequest> = {},
  lifecycle: { connected?: boolean; node?: Record<string, unknown> | null } = {}
) {
  let row = {
    id: '33333333-3333-4333-8333-333333333333',
    connectorId: input.connectorId,
    resourceId: null,
    nodeId: 'node',
    actorId: actor.id,
    action: 'create',
    phase: 'pending',
    request: input,
    requestHash: 'hash',
    generation: 1,
    leaseOwner: 'worker',
    leaseExpiresAt: new Date(Date.now() + 90000),
    bootstrapExpiresAt: new Date(Date.now() + 3600000),
    encryptedBootstrap: '{}',
    dispatchStartedAt: null,
    providerOperation: null,
    result: null,
    ...patch,
  } as HostingOperationRow;
  const operations = {
    due: vi.fn(async () => (['failed', 'ready'].includes(row.phase) ? [] : [row])),
    claim: vi.fn(async () => row),
    renew: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    update: vi.fn(async (_owned, change) => {
      row = { ...row, ...change };
      allocation.rows = [...allocation.rows.filter((saved) => saved.id !== row.id), row];
      return row;
    }),
    dispatch: vi.fn(async (_owned, phase) => {
      row = { ...row, phase, dispatchStartedAt: new Date(), result: { ...row.result, dispatchStage: phase } };
      return row;
    }),
    dispatchOrderCredit: vi.fn(async (_owned, _connector, payment) => {
      if (row.result?.creditPayment || ['ready', 'failed'].includes(row.phase)) throw new Error('payment blocked');
      row = { ...row, result: { ...row.result, creditPayment: { ...payment, startedAt: new Date().toISOString() } } };
      return row;
    }),
    finish: vi.fn(async (_owned, phase, result, error) => {
      row = {
        ...row,
        phase,
        encryptedBootstrap: null,
        completedAt: new Date(),
        result: { ...row.result, ...result },
        errorCode: error?.code,
        errorMessage: error?.message,
      };
      return row;
    }),
    findIntent: vi.fn(async () => null as HostingOperationRow | null),
    get: vi.fn(async () => row),
  };
  const stored = {
    id: 'resource',
    connectorId: input.connectorId,
    origin: 'created',
    remoteId: snapshot.remoteId,
    incarnation: snapshot.incarnation,
    snapshot,
    observedAt: new Date(),
    missingSince: null,
    managedHostIdentity: null,
  };
  const resourceUpdates: Record<string, unknown>[] = [];
  const db = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      let owns = false;
      try {
        return await callback({
          execute: async () => {
            if (allocation.held) return { rows: [{ acquired: false }] };
            owns = allocation.held = true;
            return { rows: [{ acquired: true }] };
          },
          select: () => ({
            from: (table: unknown) => ({
              where: async () =>
                table === hostingResources ? [stored] : allocation.rows.filter((saved) => saved.id !== row.id),
            }),
          }),
        });
      } finally {
        if (owns) allocation.held = false;
      }
    },
    select: vi.fn(() => ({
      from: (table: unknown) => {
        const result = () =>
          table === hostingOperations
            ? [row]
            : table === hostingResources
              ? [stored]
              : table === nodes && lifecycle.node
                ? [lifecycle.node]
                : table === nodes && lifecycle.node !== null
                  ? [{ id: row.nodeId }]
                  : [];
        return { where: () => Object.assign(Promise.resolve(result()), { limit: async () => result() }) };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (change: Record<string, unknown>) => ({
        where: async () => {
          if (table === hostingResources) resourceUpdates.push(change);
          return [];
        },
      }),
    })),
  };
  const adapter = {
    test: vi.fn(async () => ({ authority: 'account', capabilities: hostingCapabilities({ create: true }) })),
    validateCreate: vi.fn(async () => {}),
    catalog: vi.fn(async () => catalog),
    create: vi.fn(
      async (_input: HostingCreateRequest): Promise<HostingProviderOperation> => ({
        id: 'task',
        resourceId: '250',
        status: 'running',
      })
    ),
    getResource: vi.fn(async () => snapshot),
    listResources: vi.fn(async () => ({ resources: [] as HostingResourceSnapshot[], complete: true })),
    operation: vi.fn(async (): Promise<HostingProviderOperation> => ({ id: 'task', status: 'succeeded' })),
    bootstrap: vi.fn(async () => ({ id: 'guest:eu:250:42', status: 'running' })),
    guestIdentity: vi.fn(async () => null),
    prepare: vi.fn(async () => ({ id: 'prepare', status: 'running' })),
    reconcilePreparation: vi.fn(async () => null as HostingProviderOperation | null),
  };
  const connectors = {
    get: vi.fn(async () => ({ id: input.connectorId, provider: 'proxmox' })),
    settings: vi.fn(() => ({ resourceIds: [] })),
    adapter: vi.fn(() => adapter),
    changed: vi.fn(),
  };
  const nodeService = {
    create: vi.fn(),
    getGatewayEnrollmentTargets: vi.fn(async () => ({ public: { gateway: 'gateway.example.test:9443' } })),
  };
  const service = new HostingProvisioningService(
    db as never,
    connectors as never,
    operations as never,
    nodeService as never,
    {
      decryptString: () =>
        JSON.stringify({ script: 'installer', create: { ...input, marker: `gw-${row.id}`, ...createPatch } }),
    } as never,
    { getUserById: async () => actor } as never,
    { isNodeConnected: () => lifecycle.connected ?? false } as never,
    { log: vi.fn() } as never,
    { executeForHosting: vi.fn() } as never
  );
  return { service, operations, adapter, connectors, nodeService, resourceUpdates, row: () => row };
}

describe('hosting paid provisioning state machine', () => {
  function unpaidOrder() {
    const test = runner({
      phase: 'awaiting_payment',
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'awaiting_payment', invoiceId: '900' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    const invoice = vi.fn(async () => ({ id: '900', status: 'unpaid' }));
    const payOrderInvoice = vi.fn(async (_id, _marker, _quote, persistAttempt) => {
      await persistAttempt({ invoiceId: '900', amount: '6', currency: 'USD' });
    });
    Object.assign(test.adapter, { invoice, payOrderInvoice });
    return { ...test, invoice, payOrderInvoice };
  }
  it('fences credit before dispatch and checks the same invoice without paying again', async () => {
    const test = unpaidOrder();
    await test.service.reconcileDue();
    expect(test.operations.dispatchOrderCredit).toHaveBeenCalledOnce();
    expect(test.row().result?.creditPayment).toMatchObject({ invoiceId: '900', amount: '6' });
    await test.service.reconcileDue();
    expect(test.payOrderInvoice).toHaveBeenCalledOnce();
    expect(test.adapter.create).not.toHaveBeenCalled();
    test.invoice.mockResolvedValue({ id: '900', status: 'paid' });
    await test.service.reconcileDue();
    expect(test.row().providerOperation).toMatchObject({ invoiceId: '900', status: 'running' });
    expect(test.payOrderInvoice).toHaveBeenCalledOnce();
  });
  it('retains the durable payment fence after a timeout and worker reclaim', async () => {
    const test = unpaidOrder();
    test.payOrderInvoice.mockImplementation(async (_id, _marker, _quote, persistAttempt) => {
      await persistAttempt({ invoiceId: '900', amount: '6', currency: 'USD' });
      throw new HostingProviderError(504, true, 'Credit response lost');
    });
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.payOrderInvoice).toHaveBeenCalledOnce();
    expect(test.row().result?.creditPayment).toBeTruthy();
    expect(test.row().phase).toBe('awaiting_payment');
  });
  it('does not pay cancelled invoices or orders with expired bootstrap', async () => {
    const test = unpaidOrder();
    test.invoice.mockResolvedValue({ id: '900', status: 'cancelled' });
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({ phase: 'failed', errorCode: 'HOSTING_ORDER_INVOICE_CANCELLED' });
    expect(test.payOrderInvoice).not.toHaveBeenCalled();
    const expired = unpaidOrder();
    await expired.operations.update(expired.row(), { bootstrapExpiresAt: new Date(0) });
    await expired.service.reconcileDue();
    expect(expired.payOrderInvoice).not.toHaveBeenCalled();
  });
  it('preserves confirmed credit rejection and resumes after verified external invoice payment', async () => {
    const test = unpaidOrder();
    test.payOrderInvoice.mockImplementation(async (_id, _marker, _quote, persistAttempt) => {
      await persistAttempt({ invoiceId: '900', amount: '6', currency: 'USD' });
      throw new HostingProviderError(403, false, 'Access denied');
    });
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'awaiting_payment',
      errorCode: 'HOSTING_CREDIT_PAYMENT_REJECTED',
      result: { creditPayment: { status: 'rejected' } },
    });
    expect(test.payOrderInvoice).toHaveBeenCalledOnce();
    test.invoice.mockResolvedValue({ id: '900', status: 'paid' });
    await test.service.reconcileDue();
    expect(test.row().providerOperation?.status).toBe('running');
    expect(test.row().errorCode).toBeNull();
  });
  it('does not advance a paid invoice that fails order ownership validation', async () => {
    const test = unpaidOrder();
    test.invoice.mockResolvedValue({ id: '900', status: 'paid' });
    const orderInvoice = vi.fn(async () => {
      throw new HostingProviderError(409, false, 'Wrong order invoice');
    });
    Object.assign(test.adapter, { orderInvoice });
    await test.service.reconcileDue();
    expect(orderInvoice).toHaveBeenCalledWith('900', `gw-${test.row().id}`, input.confirmedPrice);
    expect(test.row().providerOperation?.status).toBe('awaiting_payment');
    expect(test.payOrderInvoice).not.toHaveBeenCalled();
    expect(test.adapter.listResources).not.toHaveBeenCalled();
  });
  it('recovers an idless order invoice without reissuing create', async () => {
    const test = unpaidOrder();
    await test.operations.update(test.row(), { providerOperation: { id: null, status: 'unknown' } });
    const findOrderInvoice = vi.fn(async () => '900');
    Object.assign(test.adapter, { findOrderInvoice });
    await test.service.reconcileDue();
    expect(findOrderInvoice).toHaveBeenCalledWith(`gw-${test.row().id}`);
    expect(test.row().providerOperation?.invoiceId).toBe('900');
    expect(test.payOrderInvoice).toHaveBeenCalledOnce();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('rejects DO scopes before reserving a node or an order', async () => {
    const test = runner();
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'digitalocean' });
    const capabilities = hostingCapabilities({});
    capabilities.create = { available: false, reasonCode: 'permission_denied', reason: 'Missing tag:create' };
    test.adapter.test.mockResolvedValue({ authority: 'account', capabilities });
    await expect(test.service.create(input, actor)).rejects.toThrow('Missing tag:create');
    expect(test.nodeService.create).not.toHaveBeenCalled();
    expect(test.nodeService.getGatewayEnrollmentTargets).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('fails a queued create before dispatch when scope validation is denied', async () => {
    const test = runner();
    test.adapter.validateCreate.mockRejectedValue(new HostingProviderError(403, false, 'Missing tag:create'));
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({ phase: 'failed', errorMessage: 'Missing tag:create' });
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it.each([
    ['a foreign-key-cleared node reference', { nodeId: null }, {}],
    ['a node deleted after the worker claimed the operation', { nodeId: 'deleted-node' }, { node: null }],
  ])('finishes safely when %s', async (_scenario, patch, lifecycle) => {
    const test = runner(
      {
        phase: 'unknown',
        resourceId: 'resource',
        dispatchStartedAt: new Date(),
        result: { dispatchStage: 'installing' },
        ...patch,
      },
      undefined,
      {},
      lifecycle
    );

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'failed',
      errorCode: 'HOSTING_NODE_MISSING',
      result: { resourceId: 'resource' },
      errorMessage: expect.stringContaining('check the provider VM'),
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.getResource).not.toHaveBeenCalled();
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
  });
  it('finishes a pre-dispatch create without a tracked resource when its node disappears', async () => {
    const test = runner({ action: 'create', nodeId: null, resourceId: null, dispatchStartedAt: null });

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({ phase: 'failed', errorCode: 'HOSTING_NODE_MISSING' });
    expect(test.operations.finish).toHaveBeenCalledOnce();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.getResource).not.toHaveBeenCalled();
  });
  it('preserves an ambiguous dispatched create without a tracked resource when its node disappears', async () => {
    const test = runner({
      action: 'create',
      phase: 'unknown',
      nodeId: null,
      resourceId: null,
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'dispatching' },
    });

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'unknown',
      errorCode: 'HOSTING_NODE_MISSING',
      errorMessage: expect.stringContaining('provider create outcome remains unconfirmed'),
    });
    expect(test.operations.finish).not.toHaveBeenCalled();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.getResource).not.toHaveBeenCalled();
    expect(test.adapter.listResources).not.toHaveBeenCalled();
  });
  it.each([
    400, 401, 403, 404, 405, 413, 415, 422, 429,
  ])('reports an explicit initial create rejection (HTTP %s) without retrying the order', async (status) => {
    const test = runner();
    test.adapter.create.mockRejectedValueOnce(new HostingProviderError(status, false, `Provider HTTP ${status}`));
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'failed',
      errorCode: 'HOSTING_PROVIDER_ERROR',
      errorMessage: `Provider HTTP ${status}`,
      encryptedBootstrap: null,
    });
    await test.service.reconcileDue();
    expect(test.adapter.create).toHaveBeenCalledOnce();
  });
  it.each([
    [408, false],
    [502, true],
    [403, true],
  ])('keeps an uncertain create fenced (HTTP %s, uncertain %s) and preserves its diagnostic', async (status, unknown) => {
    const test = runner();
    test.adapter.create.mockRejectedValueOnce(
      new HostingProviderError(Number(status), Boolean(unknown), 'Original diagnostic')
    );
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'unknown',
      errorCode: 'HOSTING_PROVIDER_ERROR',
      errorMessage: 'Original diagnostic',
    });
    expect(test.adapter.create).toHaveBeenCalledOnce();
  });
  it('does not treat a later installation rejection as proof the VM was never created', async () => {
    const test = runner({
      phase: 'provisioning',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'installing' },
    });
    test.adapter.getResource.mockRejectedValueOnce(new HostingProviderError(403, false, 'Access revoked'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('unknown');
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it.each([
    '22.04',
    '24.04',
    '26.04',
  ])('allows Ubuntu %s through quote validation without a Proxmox canonical image', (version) => {
    expect(() =>
      assertHostingQuote(
        input,
        { ...catalog, images: [{ ...catalog.images[0]!, operatingSystem: { distribution: 'ubuntu', version } }] },
        false
      )
    ).not.toThrow();
  });
  it('rejects an otherwise supported GPU image for an incompatible size before dispatch', async () => {
    const test = runner();
    test.adapter.catalog.mockResolvedValue({
      ...catalog,
      images: [{ ...catalog.images[0]!, compatibleSizes: ['gpu-h100x1-80gb'] }],
    });
    await expect(test.service.create(input, actor)).rejects.toMatchObject({
      code: 'HOSTING_CONFIGURATION_UNAVAILABLE',
    });
    expect(test.nodeService.create).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'debian', name: 'Debian' },
    { ...catalog.images[0]!, operatingSystem: { distribution: 'ubuntu', version: '28.04' } },
    { ...catalog.images[0]!, architecture: 'arm64' },
  ])('rejects unapproved images before intent creation and before provider dispatch', async (image) => {
    const test = runner();
    test.adapter.catalog.mockResolvedValue({ ...catalog, images: [image as HostingCatalog['images'][number]] });
    await expect(test.service.create(input, actor)).rejects.toMatchObject({ code: 'HOSTING_IMAGE_UNSUPPORTED' });
    expect(test.nodeService.create).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
  });
  it('rejects unsupported role/image combinations before any provider order', () => {
    expect(() =>
      assertHostingQuote(
        input,
        { ...catalog, images: [{ ...catalog.images[0]!, supportedRoles: ['monitoring'] }] },
        true
      )
    ).toThrow(/operating system/);
  });
  it('keeps a stopped cloud VM provisioning without dispatching a QGA installer', async () => {
    const test = runner({ phase: 'provisioning', resourceId: 'resource' });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'digitalocean' });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('provisioning');
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
    expect(test.adapter.prepare).not.toHaveBeenCalled();
  });
  it('starts cloud-init installation only after the VM is running without dispatching QGA', async () => {
    const test = runner({ phase: 'provisioning', resourceId: 'resource' }, undefined, {
      proxmox: {
        nodes: ['eu'],
        storage: 'zfs',
        bridge: 'vmbr0',
        network: 'dhcp',
        imageStorage: 'local',
        seedStorage: 'local',
      },
    });
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('installing');
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
    expect(test.adapter.prepare).not.toHaveBeenCalled();
  });
  it('advances cloud-init installation only after enrollment evidence appears', async () => {
    const test = runner(
      { phase: 'installing', resourceId: 'resource' },
      undefined,
      {},
      { node: { id: 'node', certificateFingerprint: 'fingerprint', enrollmentTokenHash: null } }
    );
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('enrolling');
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
  });
  it('accepts an authenticated node connection as cloud-init enrollment evidence', async () => {
    const test = runner({ phase: 'installing', resourceId: 'resource' }, undefined, {}, { connected: true });
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('enrolling');
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
  });
  it('persists each identity-checked runner snapshot for live provisioning status', async () => {
    const test = runner({ phase: 'provisioning', resourceId: 'resource' });
    const observed = { ...snapshot, powerState: 'stopped' as const, observedAt: '2026-09-06T12:00:00.000Z' };
    test.adapter.getResource.mockResolvedValue(observed);
    await test.service.reconcileDue();
    expect(test.resourceUpdates).toContainEqual({ snapshot: observed, observedAt: new Date(observed.observedAt) });
  });
  it('does not repeat preparation with a lost task response', async () => {
    const test = runner({
      phase: 'unknown',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'configuring' },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    await test.service.reconcileDue();
    expect(test.adapter.prepare).not.toHaveBeenCalled();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('recovers the exact prepared task and records success before advancing its stage', async () => {
    const test = runner({
      phase: 'unknown',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'configuring', preparationDispatch: 'image', preparationSince: 100 },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    test.adapter.reconcilePreparation.mockResolvedValue({
      id: 'download-task',
      status: 'running',
      preparationStage: 'image',
    });
    await test.service.reconcileDue();
    expect(test.adapter.reconcilePreparation).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'image', 100);
    expect(test.adapter.operation).toHaveBeenCalledWith('download-task', snapshot.remoteId);
    expect(test.row().result?.preparationStage).toBe('image');
    expect(test.adapter.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationStage: 'image', beforePreparation: expect.any(Function) })
    );
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('never starts a VM twice when the pre-poll power snapshot is stale', async () => {
    const test = runner({
      phase: 'configuring',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'start-task', status: 'running', preparationStage: 'start' },
      result: { dispatchStage: 'configuring', preparationDispatch: 'start', preparationStage: 'disk' },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    await test.service.reconcileDue();
    expect(test.row().result?.preparationStage).toBe('start');
    expect(test.adapter.prepare).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.adapter.prepare).not.toHaveBeenCalled();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('persists a completed boot task before asking the adapter to verify and start', async () => {
    const test = runner({
      phase: 'configuring',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'boot-task', status: 'running', preparationStage: 'boot' },
      result: { dispatchStage: 'configuring', preparationDispatch: 'boot', preparationStage: 'disk' },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    await test.service.reconcileDue();
    expect(test.adapter.operation).toHaveBeenCalledWith('boot-task', snapshot.remoteId);
    expect(test.row().result?.preparationStage).toBe('boot');
    expect(test.adapter.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationStage: 'boot' })
    );
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
  });
  it.each([
    'firewall',
    'network',
  ] as const)('persists synchronous %s completion and clears the dispatch fence', async (stage) => {
    const test = runner({
      phase: 'provisioning',
      resourceId: 'resource',
      result: { preparationStage: stage === 'firewall' ? 'boot' : 'firewall' },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    test.adapter.prepare.mockResolvedValue({ id: null, status: 'succeeded', preparationStage: stage } as never);
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('provisioning');
    expect(test.row().dispatchStartedAt).toBeNull();
    expect(test.row().result?.preparationStage).toBe(stage);
    await test.service.reconcileDue();
    expect(test.adapter.prepare).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationStage: stage })
    );
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it.each([
    'firewall',
    'network',
  ] as const)('resumes an applied %s write after a lost response without another create', async (stage) => {
    const test = runner({
      phase: 'unknown',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'configuring', preparationDispatch: stage, preparationSince: 100 },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    test.adapter.reconcilePreparation.mockResolvedValue({ id: null, status: 'succeeded', preparationStage: stage });
    await test.service.reconcileDue();
    expect(test.adapter.reconcilePreparation).toHaveBeenCalledWith(expect.anything(), expect.anything(), stage, 100);
    expect(test.adapter.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationStage: stage })
    );
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it.each([
    'HOSTING_BOOT_ORDER_UNVERIFIED',
    'HOSTING_INITIAL_FIREWALL_UNVERIFIED',
  ])('marks a confirmed pre-start verification failure (%s) as failed instead of waiting forever in pending', async (code) => {
    const test = runner({
      phase: 'configuring',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'boot-task', status: 'running', preparationStage: 'boot' },
      result: { dispatchStage: 'configuring', preparationDispatch: 'boot', preparationStage: 'disk' },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    test.adapter.prepare.mockRejectedValue(new AppError(409, code, 'Pre-start configuration not confirmed'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('failed');
    expect(test.row().errorCode).toBe(code);
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
  ])('recovers a lost boot response only with provider confirmation (confirmed=%s)', async (confirmed) => {
    const test = runner({
      phase: 'unknown',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: {
        dispatchStage: 'configuring',
        preparationDispatch: 'boot',
        preparationStage: 'disk',
        preparationSince: 100,
      },
    });
    test.adapter.getResource.mockResolvedValue({ ...snapshot, powerState: 'stopped' });
    test.adapter.reconcilePreparation.mockResolvedValue(
      confirmed ? { id: null, status: 'succeeded', preparationStage: 'boot' } : null
    );
    await test.service.reconcileDue();
    expect(test.adapter.reconcilePreparation).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'boot', 100);
    if (confirmed) {
      expect(test.row().result?.preparationStage).toBe('boot');
      expect(test.adapter.prepare).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ preparationStage: 'boot' })
      );
    } else {
      expect(test.row().phase).toBe('unknown');
      expect(test.adapter.prepare).not.toHaveBeenCalled();
    }
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('serializes concurrent PVE allocation and reserves accepted IDs before inventory catches up', async () => {
    const allocation = { held: false, rows: [] as HostingOperationRow[] };
    const first = runner({}, allocation);
    const second = runner({ id: '44444444-4444-4444-8444-444444444444' }, allocation);
    let complete!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    first.adapter.create.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { id: 'task', resourceId: '251', status: 'running' };
    });
    const running = first.service.reconcileDue();
    await started;
    await second.service.reconcileDue();
    expect(second.operations.dispatch).not.toHaveBeenCalled();
    expect(second.adapter.create).not.toHaveBeenCalled();
    expect(second.row().phase).toBe('pending');
    complete();
    await running;
    await second.service.reconcileDue();
    expect(second.adapter.create).toHaveBeenCalledOnce();
    expect(second.adapter.create.mock.calls[0][0]).toMatchObject({
      excludedRemoteIds: expect.arrayContaining(['251']),
    });
  });
  it('reports execution permission denial instead of waiting for QGA until expiry', async () => {
    const test = runner({ phase: 'provisioning', resourceId: 'resource' });
    test.adapter.getResource.mockResolvedValueOnce({
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        bootstrap: {
          available: false,
          reasonCode: 'permission_denied',
          reason: 'Provider token lacks execution rights',
        },
      },
    });
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({ phase: 'failed', errorCode: 'HOSTING_PROVIDER_PERMISSION_REQUIRED' });
    expect(test.operations.dispatch).not.toHaveBeenCalled();
  });
  it('waits for a booting guest agent before fencing or sending the installer', async () => {
    const test = runner({ phase: 'provisioning', resourceId: 'resource' });
    test.adapter.getResource.mockResolvedValueOnce({ ...snapshot, capabilities: hostingCapabilities({}) });
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'provisioning',
      dispatchStartedAt: null,
      errorCode: 'HOSTING_GUEST_AGENT_PENDING',
    });
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.adapter.bootstrap).toHaveBeenCalledOnce();
    expect(test.row()).toMatchObject({ phase: 'installing', errorCode: null });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('recovers only a proven local pre-dispatch transport error, not an uncertain installer', async () => {
    const test = runner({
      phase: 'unknown',
      resourceId: 'resource',
      dispatchStartedAt: new Date(),
      result: { dispatchStage: 'installing' },
      errorCode: 'HOSTING_INSTALL_TRANSPORT_REQUIRED',
    });
    await test.service.reconcileDue();
    expect(test.adapter.bootstrap).toHaveBeenCalledOnce();
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('does not send an uncertain create request twice', async () => {
    const test = runner();
    test.adapter.create.mockRejectedValue(new HostingProviderError(502, true, 'Lost response'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('unknown');
    await test.service.reconcileDue();
    expect(test.adapter.create).toHaveBeenCalledTimes(1);
    expect(test.adapter.listResources).toHaveBeenCalledOnce();
  });
  it('persists HOSTKEY awaiting payment with the provider invoice reference and does not replay create', async () => {
    const test = runner();
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.create.mockResolvedValueOnce({ id: null, status: 'awaiting_payment', invoiceId: 'invoice-1' });

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'awaiting_payment',
      providerOperation: { status: 'awaiting_payment', invoiceId: 'invoice-1' },
    });
    await test.service.reconcileDue();
    expect(test.adapter.create).toHaveBeenCalledOnce();
    expect(test.adapter.listResources).not.toHaveBeenCalled();
  });
  it('keeps HOSTKEY awaiting payment fenced when no invoice reference is available', async () => {
    const test = runner({
      phase: 'awaiting_payment',
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'awaiting_payment' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });

    await test.service.reconcileDue();

    expect(test.row().phase).toBe('awaiting_payment');
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.adapter.listResources).not.toHaveBeenCalled();
  });
  it('keeps a paid HOSTKEY order provisioning until marker inventory exposes its VM', async () => {
    const test = runner({
      phase: 'awaiting_payment',
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'awaiting_payment', invoiceId: 'invoice-1' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    const invoice = vi.fn(async () => ({ status: 'paid', resourceIds: ['whmcs-service-id'] }));
    Object.assign(test.adapter, { invoice });

    await test.service.reconcileDue();

    expect(invoice).toHaveBeenCalledWith('invoice-1');
    expect(test.adapter.listResources).toHaveBeenCalledOnce();
    expect(test.row()).toMatchObject({
      phase: 'provisioning',
      providerOperation: { status: 'running', invoiceId: 'invoice-1' },
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('clears a recovered HOSTKEY inventory read error without replaying the paid order', async () => {
    const dispatchStartedAt = new Date();
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt,
      providerOperation: { id: null, status: 'running', invoiceId: 'invoice-1' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.listResources.mockRejectedValueOnce(
      new HostingProviderError(403, false, 'HOSTKEY denied access to eq/show')
    );
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({ phase: 'unknown', errorCode: 'HOSTING_PROVIDER_ERROR' });

    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'provisioning',
      errorCode: null,
      errorMessage: null,
      dispatchStartedAt,
      providerOperation: { id: null, status: 'running', invoiceId: 'invoice-1' },
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.operations.release).toHaveBeenLastCalledWith(expect.anything(), 5000);
  });
  it('does not hide a continuing HOSTKEY inventory access failure', async () => {
    const test = runner({
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'running', invoiceId: 'invoice-1' },
      result: { dispatchStage: 'dispatching' },
      errorCode: 'HOSTING_PROVIDER_ERROR',
      errorMessage: 'HOSTKEY denied access to eq/show',
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.listResources.mockRejectedValue(
      new HostingProviderError(403, false, 'HOSTKEY denied access to eq/show')
    );
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({
      phase: 'unknown',
      errorCode: 'HOSTING_PROVIDER_ERROR',
      errorMessage: 'HOSTKEY denied access to eq/show',
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('keeps an expired paid HOSTKEY order fenced when no VM is visible', async () => {
    const test = runner({
      phase: 'unknown',
      encryptedBootstrap: null,
      bootstrapExpiresAt: new Date(0),
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'awaiting_payment', invoiceId: 'invoice-1' },
      result: { dispatchStage: 'dispatching' },
      errorCode: 'HOSTING_BOOTSTRAP_EXPIRED',
      errorMessage: 'Creation outcome is unknown; no replacement VM will be ordered',
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    Object.assign(test.adapter, { invoice: vi.fn(async () => ({ status: 'paid' })) });

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'unknown',
      providerOperation: { id: null, status: 'running', invoiceId: 'invoice-1' },
      errorCode: 'HOSTING_BOOTSTRAP_EXPIRED',
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('retains the expired HOSTKEY bootstrap fence when a callback later succeeds', async () => {
    const test = runner({
      phase: 'unknown',
      encryptedBootstrap: null,
      bootstrapExpiresAt: new Date(0),
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'callback-1', status: 'pending' },
      result: { dispatchStage: 'dispatching' },
      errorCode: 'HOSTING_BOOTSTRAP_EXPIRED',
      errorMessage: 'Creation outcome is unknown; no replacement VM will be ordered',
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({ id: 'callback-1', status: 'succeeded' });

    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'unknown',
      providerOperation: { id: 'callback-1', status: 'succeeded' },
      errorCode: 'HOSTING_BOOTSTRAP_EXPIRED',
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('marks ambiguous paid HOSTKEY marker discovery unknown instead of choosing a VM', async () => {
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt: new Date(),
      providerOperation: { id: null, status: 'running', invoiceId: 'invoice-1' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.listResources.mockResolvedValueOnce({
      complete: true,
      resources: [
        { ...snapshot, marker: `gw-${test.row().id}` },
        { ...snapshot, remoteId: '251', marker: `gw-${test.row().id}` },
      ],
    });

    await test.service.reconcileDue();

    expect(test.row().phase).toBe('unknown');
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('polls a HOSTKEY create callback before resource discovery and keeps an incomplete callback fenced', async () => {
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'callback-1', status: 'pending' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({ id: 'callback-1', status: 'pending' });

    await test.service.reconcileDue();

    expect(test.adapter.operation).toHaveBeenCalledWith('callback-1', undefined);
    expect(test.adapter.listResources).not.toHaveBeenCalled();
    expect(test.row()).toMatchObject({
      phase: 'provisioning',
      dispatchStartedAt: expect.any(Date),
      providerOperation: { id: 'callback-1', status: 'pending' },
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('preserves a failed HOSTKEY callback and never replays the create order', async () => {
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'callback-1', status: 'pending' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({
      id: 'callback-1',
      status: 'failed',
      error: 'Provider rejected task',
    });

    await test.service.reconcileDue();
    await test.service.reconcileDue();

    expect(test.row()).toMatchObject({
      phase: 'failed',
      providerOperation: { id: 'callback-1', status: 'failed' },
      errorCode: 'HOSTING_PROVIDER_TASK_FAILED',
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('waits for HOSTKEY VM visibility after a succeeded callback without converting it to unknown', async () => {
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'callback-1', status: 'pending' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({ id: 'callback-1', status: 'succeeded' });

    await test.service.reconcileDue();

    expect(test.adapter.operation).toHaveBeenCalledWith('callback-1', undefined);
    expect(test.adapter.listResources).toHaveBeenCalledOnce();
    expect(test.row()).toMatchObject({
      phase: 'provisioning',
      dispatchStartedAt: expect.any(Date),
      providerOperation: { id: 'callback-1', status: 'succeeded' },
    });
    expect(test.adapter.create).not.toHaveBeenCalled();
  });
  it('does not re-poll a succeeded HOSTKEY callback while VM visibility catches up, then enrolls', async () => {
    const test = runner(
      {
        phase: 'provisioning',
        dispatchStartedAt: new Date(),
        providerOperation: { id: 'callback-1', status: 'pending' },
        result: { dispatchStage: 'dispatching' },
      },
      undefined,
      {},
      { connected: true }
    );
    const trackResource = vi.fn(async () => ({ id: 'resource' }));
    Object.assign(test.service as unknown as { trackResource: typeof trackResource }, { trackResource });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({ id: 'callback-1', status: 'succeeded', resourceId: '250' });
    test.adapter.getResource.mockRejectedValueOnce(new HostingProviderError(404, false, 'VM inventory is delayed'));

    await test.service.reconcileDue();
    await test.service.reconcileDue();

    expect(test.adapter.operation).toHaveBeenCalledOnce();
    expect(trackResource).toHaveBeenCalledOnce();
    expect(test.row()).toMatchObject({
      resourceId: 'resource',
      phase: 'installing',
      providerOperation: null,
      dispatchStartedAt: null,
    });

    await test.service.reconcileDue();

    expect(test.adapter.operation).toHaveBeenCalledOnce();
    expect(test.row().phase).toBe('enrolling');
  });
  it('retains a known HOSTKEY callback resource ID when a later callback response omits it', async () => {
    const test = runner({
      phase: 'provisioning',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'callback-1', status: 'pending', resourceId: '250' },
      result: { dispatchStage: 'dispatching' },
    });
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hostkey' });
    test.adapter.operation.mockResolvedValueOnce({ id: 'callback-1', status: 'pending' });

    await test.service.reconcileDue();

    expect(test.adapter.operation).toHaveBeenCalledWith('callback-1', '250');
    expect(test.row().providerOperation).toMatchObject({ status: 'pending', resourceId: '250' });
  });
  it('uses the persisted phase when releasing a runner lease', async () => {
    const test = runner();
    test.adapter.create.mockRejectedValueOnce(new HostingProviderError(502, true, 'Lost response'));

    await test.service.reconcileDue();

    expect(test.row().phase).toBe('unknown');
    expect(test.operations.release).toHaveBeenCalledWith(expect.anything(), 60_000);
  });
  it('never redispatches an unknown retry installer even after its process could have exited', async () => {
    const test = runner({
      action: 'install',
      resourceId: 'resource',
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      result: { retryOf: 'original', dispatchStage: 'installing' },
    });
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.row().phase).toBe('unknown');
  });
  it('polls a known uncertain guest task and then waits for actual enrollment', async () => {
    const test = runner({
      action: 'install',
      resourceId: 'resource',
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'guest:eu:250:42', status: 'running' },
      result: { retryOf: 'original', dispatchStage: 'installing' },
    });
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('installing');
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('installing');
    expect(test.adapter.bootstrap).not.toHaveBeenCalled();
    expect(test.operations.finish).not.toHaveBeenCalled();
  });
  it('keeps searching for a paid VM after bootstrap expiry rather than freezing discovery', async () => {
    const test = runner({
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      bootstrapExpiresAt: new Date(0),
      result: { dispatchStage: 'dispatching' },
    });
    await test.service.reconcileDue();
    expect(test.adapter.listResources).toHaveBeenCalledOnce();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.row().encryptedBootstrap).toBeNull();
  });
  it('preserves a friendly display name separately from the provider hostname', async () => {
    const test = runner();
    test.connectors.get.mockResolvedValue({ id: input.connectorId, provider: 'hetzner' });
    const reserve = vi.fn(async (_input, initialize) => initialize({}, 'operation'));
    Object.assign(test.operations, { reserve });
    test.nodeService.create.mockRejectedValue(new Error('stop-after-node-input'));
    await expect(test.service.create({ ...input, displayName: 'Build Worker 2' }, actor)).rejects.toThrow(
      'stop-after-node-input'
    );
    expect(test.nodeService.create).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'worker', displayName: 'Build Worker 2' }),
      actor.id,
      {}
    );
  });
  it('returns a persisted request before a changed quote can be mistaken for a new admission failure', async () => {
    const test = runner();
    test.operations.findIntent.mockResolvedValue(test.row());
    await test.service.create(input, actor);
    expect(test.operations.get).toHaveBeenCalledWith(test.row().id, actor);
    expect(test.adapter.catalog).not.toHaveBeenCalled();
    expect(test.nodeService.getGatewayEnrollmentTargets).not.toHaveBeenCalled();
  });
  it('checks the quote immediately before the provider mutation', async () => {
    const test = runner();
    test.adapter.catalog.mockResolvedValue({
      ...catalog,
      sizes: [{ ...catalog.sizes[0], price: { amount: '9', currency: 'USD', estimated: true } }],
    });
    await test.service.reconcileDue();
    expect(test.adapter.create).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.row().errorCode).toBe('HOSTING_PRICE_CHANGED');
  });
  it('will not order without a provider quote and uses the selected region price', () => {
    expect(() => assertHostingQuote(input, { ...catalog, sizes: [{ id: 'small', name: 'Small' }] }, false)).toThrow();
    expect(() =>
      assertHostingQuote(
        input,
        {
          ...catalog,
          sizes: [{ ...catalog.sizes[0], locationPrices: { eu: { amount: '7', currency: 'USD', estimated: true } } }],
        },
        false
      )
    ).toThrow();
    expect(() => assertHostingQuote(input, catalog, false)).not.toThrow();
  });
});
