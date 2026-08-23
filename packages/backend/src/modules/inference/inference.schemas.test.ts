import { describe, expect, it } from 'vitest';
import { CreateInferenceModelSourceSchema, UpdateInferenceProviderConnectionSchema } from './inference.schemas';

describe('CreateInferenceModelSourceSchema', () => {
  const source = {
    connectionId: '6f357761-6cc7-4a6c-a28a-cf996a58ce0b',
    upstreamModelId: 'gpt-5.6-luna',
    reasoningEffortMap: {},
  };

  it('accepts a partial manual metadata override', () => {
    expect(
      CreateInferenceModelSourceSchema.parse({
        ...source,
        manualMetadata: { contextWindow: 450_000 },
      }).manualMetadata
    ).toEqual({ contextWindow: 450_000 });
  });

  it('accepts an auto-compaction-only override', () => {
    expect(
      CreateInferenceModelSourceSchema.parse({
        ...source,
        manualMetadata: { autoCompactTokenLimit: 256_000 },
      }).manualMetadata
    ).toEqual({ autoCompactTokenLimit: 256_000 });
  });
});

describe('UpdateInferenceProviderConnectionSchema', () => {
  it('requires at least a one percent subscription reserve', () => {
    expect(UpdateInferenceProviderConnectionSchema.safeParse({ minimumRemainingPercent: 1 }).success).toBe(true);
    expect(UpdateInferenceProviderConnectionSchema.safeParse({ minimumRemainingPercent: 0 }).success).toBe(false);
  });
});
