import { describe, expect, it, vi } from 'vitest';
import { GeneralSettingsService, normalizePublicUrl } from './general-settings.service.js';

describe('normalizePublicUrl', () => {
  it('stores only a canonical http(s) origin', () => {
    expect(normalizePublicUrl(' HTTPS://Gateway.Example.com:443/ ')).toBe('https://gateway.example.com');
    expect(normalizePublicUrl('http://[2001:db8::1]:3000')).toBe('http://[2001:db8::1]:3000');
  });

  it.each([
    'ftp://gateway.example.com',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com/app',
  ])('rejects a non-origin public URL: %s', (value) => expect(() => normalizePublicUrl(value)).toThrow());

  it('does not infer a public URL when it is blank', () => {
    expect(normalizePublicUrl('')).toBeNull();
  });
});

describe('GeneralSettingsService inference feature', () => {
  it('backfills disabled and applies persisted updates without a restart', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        value: {
          features: { pkiEnabled: true, domainsEnabled: true },
        },
      },
    ]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate })),
      })),
    };
    const service = new GeneralSettingsService(db as never);

    expect((await service.getConfig()).features.inferenceEnabled).toBe(false);
    expect((await service.getConfig()).inference.harnessSpecificEndpointsEnabled).toBe(false);
    expect(
      (
        await service.updateConfig({
          features: { inferenceEnabled: true },
        })
      ).features.inferenceEnabled
    ).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(true);
    expect(
      (
        await service.updateInferenceSettings({
          harnessSpecificEndpointsEnabled: true,
        })
      ).harnessSpecificEndpointsEnabled
    ).toBe(true);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
  });

  it('invokes the assistant fallback when inference is turned off', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        value: {
          features: { pkiEnabled: true, domainsEnabled: true, inferenceEnabled: true },
        },
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const service = new GeneralSettingsService(db as never);
    const fallback = vi.fn().mockResolvedValue(undefined);
    service.setInferenceDisabledHandler(fallback);

    await service.updateConfig({ features: { inferenceEnabled: false } });

    expect(fallback).toHaveBeenCalledOnce();
  });
});
