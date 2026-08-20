import { describe, expect, it } from 'vitest';
import { UpdateNodeSchema } from './nodes.schemas.js';

describe('UpdateNodeSchema service addresses', () => {
  it('accepts up to ten ordered unique service addresses', () => {
    const serviceAddresses = Array.from({ length: 10 }, (_, index) => `service-${index + 1}.example.com`);

    expect(UpdateNodeSchema.parse({ serviceAddresses })).toEqual({ serviceAddresses });
  });

  it('rejects more than ten service addresses', () => {
    const serviceAddresses = Array.from({ length: 11 }, (_, index) => `service-${index + 1}.example.com`);

    expect(UpdateNodeSchema.safeParse({ serviceAddresses }).success).toBe(false);
  });

  it('trims addresses and rejects duplicates after normalization', () => {
    expect(
      UpdateNodeSchema.safeParse({ serviceAddresses: [' service.example.com ', 'service.example.com'] }).success
    ).toBe(false);
  });

  it('rejects mixing the canonical list with legacy address fields', () => {
    expect(
      UpdateNodeSchema.safeParse({
        serviceAddresses: ['service.example.com'],
        serviceAddress: 'legacy.example.com',
      }).success
    ).toBe(false);
  });
});
