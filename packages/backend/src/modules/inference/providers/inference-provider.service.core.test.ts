import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import { InferenceProviderRegistry } from './inference-provider.registry.js';
import { InferenceProviderService } from './inference-provider.service.js';

/** Awaitable drizzle query chain: every combinator returns the same chain. */
function selectChain(rows: unknown[]) {
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.limit = vi.fn().mockResolvedValue(rows);
  return chain;
}

function updateChain() {
  const chain = { set: vi.fn(), where: vi.fn().mockResolvedValue(undefined) };
  chain.set.mockReturnValue(chain);
  return chain;
}

const CORE_CONNECTION = {
  id: 'conn-1',
  providerId: 'openai-apikey',
  name: 'OpenAI prod',
  authType: 'api_key',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  routingOrder: 0,
  status: 'pending',
  syncStatus: 'idle',
  metadata: { coreManaged: true },
  createdBy: 'user-1',
  lastSyncedAt: null,
  nextSyncAt: null,
  createdAt: new Date('2026-08-19T00:00:00.000Z'),
  updatedAt: new Date('2026-08-19T00:00:00.000Z'),
  deletedAt: null,
};

function createService(options: {
  connections?: unknown[];
  coreReady?: boolean;
  client?: Record<string, unknown>;
  bridgeError?: unknown;
}) {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    query: {
      inferenceProviderConnections: {
        findFirst: vi.fn().mockResolvedValue(CORE_CONNECTION),
      },
    },
  };
  const client = {
    createCoreProvider: vi.fn().mockResolvedValue(undefined),
    patchCoreProvider: vi.fn().mockResolvedValue(undefined),
    deleteCoreProvider: vi.fn().mockResolvedValue(undefined),
    deleteCoreCodexAccount: vi.fn().mockResolvedValue(undefined),
    setCoreCodexAccountPaused: vi.fn().mockResolvedValue(undefined),
    setCoreCodexPoolStrategy: vi.fn().mockResolvedValue(undefined),
    setCoreOauthPoolStrategy: vi.fn().mockResolvedValue(undefined),
    listCoreProviders: vi.fn().mockResolvedValue([{ name: 'core-conn-1', hasApiKey: true }]),
    listCoreModels: vi.fn().mockResolvedValue([
      {
        provider: 'core-conn-1',
        id: 'gpt-5.5',
        namespaced: 'core-conn-1/gpt-5.5',
        contextWindow: 400_000,
        pricing: {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 6.25,
          source: 'opencodex-catalog',
        },
      },
      { provider: 'core-conn-1', id: 'static-only', namespaced: 'core-conn-1/static-only' },
      { provider: 'other', id: 'ignored', namespaced: 'other/ignored' },
    ]),
    coreProviderLiveModelIds: vi.fn().mockResolvedValue(['gpt-5.5']),
    coreProviderQuotas: vi.fn().mockResolvedValue({
      reports: [{ provider: 'core-conn-1', quota: { weeklyPercent: 40, weeklyResetAt: 1_800_000_000_000 } }],
    }),
    coreCodexQuota: vi.fn().mockResolvedValue(null),
    ...options.client,
  };
  const bridge = {
    coreReady: vi.fn().mockResolvedValue(options.coreReady ?? true),
    requireClient: options.bridgeError
      ? vi.fn().mockRejectedValue(options.bridgeError)
      : vi.fn().mockResolvedValue(client),
    mapRoutingStrategy: (strategy: string) => strategy,
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const destinations = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  const service = new InferenceProviderService(
    db as never,
    new InferenceProviderRegistry(),
    audit as never,
    destinations as never,
    bridge as never
  );
  return { service, db, client, bridge, audit };
}

describe('inference provider service — core-managed delegation', () => {
  it('synthesizes a credential presence indicator for core-managed rows', async () => {
    const { service, db } = createService({});
    const legacy = {
      ...CORE_CONNECTION,
      id: 'conn-legacy',
      metadata: {},
      routingOrder: 1,
    };
    db.select
      .mockReturnValueOnce(selectChain([CORE_CONNECTION, legacy]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]));
    const rows = await service.listConnections();
    const coreRow = rows.find((row) => row.id === 'conn-1');
    const legacyRow = rows.find((row) => row.id === 'conn-legacy');
    expect(coreRow?.credential).toEqual({
      connectionId: 'conn-1',
      kind: 'api_key',
      last4: null,
      expiresAt: null,
    });
    expect(legacyRow?.credential).toBeNull();
  });

  it('creates key connections in the core without storing gateway credentials', async () => {
    const { service, db, client } = createService({});
    db.select.mockReturnValueOnce(selectChain([{ routingOrder: 3 }]));
    const returning = vi.fn().mockResolvedValue([CORE_CONNECTION]);
    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
    vi.spyOn(service, 'syncConnection').mockResolvedValue({ id: 'conn-1' } as never);

    const result = await service.createKeyConnection('user-1', {
      providerId: 'openai-apikey',
      name: 'OpenAI prod',
      apiKey: 'sk-live',
    });

    expect(result).toEqual({ id: 'conn-1' });
    expect(client.createCoreProvider).toHaveBeenCalledWith('core-conn-1', {
      templateId: 'openai-apikey',
      adapter: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      authMode: 'key',
      apiKey: 'sk-live',
    });
    expect(service.syncConnection).toHaveBeenCalledWith('conn-1', true);
  });

  it('removes the gateway row when the core rejects a new provider', async () => {
    const { service, db } = createService({
      client: { createCoreProvider: vi.fn().mockRejectedValue(new InferenceCoreClientError('bad base url', 400)) },
    });
    db.select.mockReturnValueOnce(selectChain([]));
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([CORE_CONNECTION]) }),
    });
    const where = vi.fn().mockResolvedValue(undefined);
    db.delete.mockReturnValue({ where });

    await expect(
      service.createKeyConnection('user-1', { providerId: 'openai-apikey', name: 'X', apiKey: 'sk-live' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INFERENCE_CORE_MANAGEMENT_FAILED' });
    expect(where).toHaveBeenCalled();
  });

  it('syncs core-managed connections from the core catalog and quota reports', async () => {
    const { service, db } = createService({});
    db.update.mockReturnValue(updateChain());
    const persistModels = vi.fn().mockResolvedValue(undefined);
    const persistQuota = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { persistModels, persistQuota });
    vi.spyOn(service, 'getConnection').mockResolvedValue({ id: 'conn-1' } as never);

    await service.syncConnection('conn-1', true);

    expect(persistModels).toHaveBeenCalledWith('conn-1', [
      expect.objectContaining({
        id: 'gpt-5.5',
        contextWindow: 400_000,
        pricing: expect.objectContaining({
          inputMicrodollarsPerMillion: 5_000_000,
          outputMicrodollarsPerMillion: 30_000_000,
        }),
        metadata: expect.objectContaining({
          coreModelId: 'core-conn-1/gpt-5.5',
          gatewayPricing: expect.objectContaining({ source: 'provider' }),
        }),
      }),
    ]);
    expect(persistQuota).toHaveBeenCalledWith('conn-1', [
      { dimension: '7d', remainingFraction: 0.6, resetAt: new Date(1_800_000_000_000) },
    ]);
    expect(service.getConnection).toHaveBeenCalledWith('conn-1');
  });

  it('repairs live discovery on an existing Alibaba Token Plan connection before syncing', async () => {
    const connection = { ...CORE_CONNECTION, providerId: 'alibaba-token-plan-intl' };
    const { service, db, client } = createService({});
    db.query.inferenceProviderConnections.findFirst.mockResolvedValue(connection);
    db.update.mockReturnValue(updateChain());
    Object.assign(service, {
      persistModels: vi.fn().mockResolvedValue(undefined),
      persistQuota: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(service, 'getConnection').mockResolvedValue({ id: 'conn-1' } as never);

    await service.syncConnection('conn-1', true);

    expect(client.patchCoreProvider).toHaveBeenCalledWith('core-conn-1', { liveModels: true });
  });

  it('marks the connection unavailable when the core lost the provider entry', async () => {
    const { service, db } = createService({ client: { listCoreProviders: vi.fn().mockResolvedValue([]) } });
    const chain = updateChain();
    db.update.mockReturnValue(chain);
    Object.assign(service, {
      persistModels: vi.fn().mockResolvedValue(undefined),
      persistQuota: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(service, 'getConnection').mockResolvedValue({ id: 'conn-1' } as never);

    await service.syncConnection('conn-1', true);

    expect(chain.set).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable', syncStatus: 'error' }));
  });

  it('mirrors enable/disable to the core provider entry before updating the row', async () => {
    const { service, db, client } = createService({});
    db.update.mockReturnValue(updateChain());
    // assertConnectionCanDisable: affected models + remaining sources
    db.select.mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
    vi.spyOn(service, 'getConnection').mockResolvedValue({ id: 'conn-1' } as never);

    await service.updateConnection('user-1', 'conn-1', { enabled: false });

    expect(client.patchCoreProvider).toHaveBeenCalledWith('core-conn-1', { disabled: true });
  });

  it('keeps routing strategy in Gateway without pushing it into core pools', async () => {
    const { service, db, client } = createService({});
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate }) });

    await service.setRoutingStrategy('user-1', 'openai', 'sequential');
    expect(client.setCoreCodexPoolStrategy).not.toHaveBeenCalled();
    expect(client.setCoreOauthPoolStrategy).not.toHaveBeenCalled();

    await service.setRoutingStrategy('user-1', 'openai-apikey', 'even');
    expect(client.setCoreCodexPoolStrategy).not.toHaveBeenCalled();
  });

  it('removes codex pool accounts on disconnect and tolerates an unreachable core', async () => {
    const oauthConnection = {
      ...CORE_CONNECTION,
      providerId: 'openai',
      authType: 'oauth',
      metadata: { coreManaged: true, coreAccountId: 'chatgpt-1' },
    };
    const { service, db, client } = createService({});
    db.query.inferenceProviderConnections.findFirst.mockResolvedValue(oauthConnection);
    db.select.mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
    db.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    db.update.mockReturnValue(updateChain());

    await service.disconnect('user-1', 'conn-1');
    expect(client.deleteCoreCodexAccount).toHaveBeenCalledWith('chatgpt-1');

    const unreachable = createService({ bridgeError: new AppError(409, 'CORE_NOT_READY', 'not ready') });
    unreachable.db.query.inferenceProviderConnections.findFirst.mockResolvedValue(oauthConnection);
    unreachable.db.select.mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
    unreachable.db.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    unreachable.db.update.mockReturnValue(updateChain());
    await expect(unreachable.service.disconnect('user-1', 'conn-1')).resolves.toBeUndefined();
  });
});
