import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { __testOnly, InferenceModelService } from './inference-model.service.js';

const MODEL = {
  id: 'model-1',
  publicId: 'gpt-5.5',
  displayName: 'GPT 5.5',
  reasoningEfforts: [],
  enabled: false,
};

const CORE_CONNECTION = {
  id: 'conn-1',
  providerId: 'openai-apikey',
  authType: 'api_key',
  syncStatus: 'success',
  metadata: { coreManaged: true },
  deletedAt: null,
};

const DISCOVERED = {
  id: 'disc-1',
  connectionId: 'conn-1',
  remoteModelId: 'gpt-5.5',
  metadata: { coreModelId: 'core-conn-1/gpt-5.5' },
};

const PRICING = {
  version: '2026-08',
  inputMicrodollarsPerMillion: 1,
  outputMicrodollarsPerMillion: 2,
  source: 'manual' as const,
};

function createService(options: { coreReady?: boolean; connection?: unknown } = {}) {
  const captures: unknown[] = [];
  const db = {
    query: {
      inferenceModels: { findFirst: vi.fn().mockResolvedValue(MODEL) },
      inferenceProviderConnections: {
        findFirst: vi.fn().mockResolvedValue(options.connection === undefined ? CORE_CONNECTION : options.connection),
      },
      inferenceDiscoveredModels: { findFirst: vi.fn().mockResolvedValue(DISCOVERED) },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        insert: vi.fn().mockReturnValue({
          values: vi.fn((values: unknown) => {
            captures.push(values);
            return {
              returning: vi.fn().mockResolvedValue([{ id: 'source-1' }]),
              onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            };
          }),
        }),
      })
    ),
  };
  const bridge = { coreReady: vi.fn().mockResolvedValue(options.coreReady ?? true) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new InferenceModelService(
    db as never,
    new InferenceProviderRegistry(),
    {} as never,
    audit as never,
    {} as never,
    undefined,
    bridge as never
  );
  Object.assign(service, { serializeModel: vi.fn().mockResolvedValue({ id: 'model-1' }) });
  return { service, captures };
}

describe('inference model sources — core-backed publish', () => {
  it('requires a core-backed connection once the core is ready', async () => {
    const { service } = createService({ connection: { ...CORE_CONNECTION, metadata: {} } });
    await expect(
      service.addSource('user-1', 'model-1', {
        connectionId: 'conn-1',
        discoveredModelId: 'disc-1',
        reasoningEffortMap: {},
        pricing: PRICING,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'INFERENCE_CORE_SOURCE_REQUIRED' });
  });

  it('allows an existing non-core connection before the core is ready', async () => {
    const { service, captures } = createService({
      coreReady: false,
      connection: { ...CORE_CONNECTION, metadata: {} },
    });
    await service.addSource('user-1', 'model-1', {
      connectionId: 'conn-1',
      discoveredModelId: 'disc-1',
      reasoningEffortMap: {},
      pricing: PRICING,
    });
    const inserted = captures[0] as Record<string, unknown>;
    expect(inserted.coreAccountId).toBeUndefined();
    expect(inserted.coreModelId).toBeUndefined();
  });

  it('pins core account and model references on core-managed sources', async () => {
    const { service, captures } = createService({});
    await service.addSource('user-1', 'model-1', {
      connectionId: 'conn-1',
      discoveredModelId: 'disc-1',
      reasoningEffortMap: {},
      pricing: PRICING,
    });
    const inserted = captures[0] as Record<string, unknown>;
    expect(inserted.coreAccountId).toBe('core-conn-1');
    expect(inserted.coreModelId).toBe('core-conn-1/gpt-5.5');
  });

  it('pins the canonical core provider for oauth connections', async () => {
    const { service, captures } = createService({
      connection: { ...CORE_CONNECTION, providerId: 'anthropic', authType: 'oauth' },
    });
    await service.addSource('user-1', 'model-1', {
      connectionId: 'conn-1',
      discoveredModelId: 'disc-1',
      reasoningEffortMap: {},
      pricing: PRICING,
    });
    const inserted = captures[0] as Record<string, unknown>;
    expect(inserted.coreAccountId).toBe('anthropic');
  });
});

describe('inference model availability — live discovered sources', () => {
  function availabilityService(
    sources: Array<{ modelId: string; sourceType: 'subscription' | 'api' }>,
    apiMonthlyMicrodollars: number
  ) {
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn().mockResolvedValue(sources),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    const db = { select: vi.fn().mockReturnValue(chain) };
    const service = new InferenceModelService(
      db as never,
      new InferenceProviderRegistry(),
      {} as never,
      {} as never,
      { effective: vi.fn().mockResolvedValue({ enabled: true, apiMonthlyMicrodollars }) } as never
    );
    return {
      availability: (
        service as unknown as {
          modelAvailabilityForUser(
            userId: string,
            modelIds: string[]
          ): Promise<{
            modelIds: string[];
            apiUsageEnabled: boolean;
          }>;
        }
      ).modelAvailabilityForUser('user-1', ['model-1']),
      chain,
    };
  }

  it('does not expose a published model when no live source remains', async () => {
    const { availability, chain } = availabilityService([], 1_000_000);
    await expect(availability).resolves.toEqual({ modelIds: [], apiUsageEnabled: true });
    expect(chain.leftJoin).toHaveBeenCalledOnce();
  });

  it('exposes a subscription-backed live source without an API budget', async () => {
    const { availability } = availabilityService([{ modelId: 'model-1', sourceType: 'subscription' }], 0);
    await expect(availability).resolves.toEqual({ modelIds: ['model-1'], apiUsageEnabled: false });
  });
});

describe('inference model capability characterization', () => {
  it('intersects enabled primary capabilities and names limiting sources', () => {
    const sourceRow = (
      name: string,
      upstreamModelId: string,
      capabilities: Record<string, boolean>,
      options: { enabled?: boolean; role?: 'primary' | 'vision_sidecar' } = {}
    ) => ({
      source: {
        enabled: options.enabled ?? true,
        upstreamModelId,
        capabilitiesOverride: null,
        metadata: { composition: { role: options.role ?? 'primary' } },
      },
      connection: { name, providerId: 'custom' },
      discovered: { modalities: ['text'], capabilities },
    });

    expect(
      __testOnly.detectedCapabilityState({ tools: true, vision: true }, [
        sourceRow('Primary A', 'model-a', { tools: true, vision: true }),
        sourceRow('Primary B', 'model-b', { tools: true, vision: false }),
        sourceRow('Disabled', 'model-disabled', { tools: false, vision: false }, { enabled: false }),
        sourceRow('Sidecar', 'model-sidecar', { tools: false, vision: true }, { role: 'vision_sidecar' }),
      ] as never)
    ).toEqual({
      effective: { tools: true, vision: false },
      limitations: { vision: ['Primary B · model-b'] },
    });
  });
});
