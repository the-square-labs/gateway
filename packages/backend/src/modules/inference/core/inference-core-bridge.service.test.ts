import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { InferenceCoreBridgeService } from './inference-core-bridge.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';

afterEach(() => {
  container.reset();
  vi.unstubAllGlobals();
});

function harness(supported: boolean, state = 'update_available') {
  const settings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
  settings.requestLimits.inferenceHttpBodyMaxBytes = 1024 * 1024 * 1024;
  settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 256 * 1024 * 1024;
  container.registerInstance(EnvironmentSettingsService, { getSnapshot: () => settings } as never);
  const row = {
    state,
    installedDigest: 'digest',
    credentialsPayload: 'sealed',
    credentialsDek: 'dek',
    credentialKeyVersion: 1,
  };
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      service: 'opencodex',
      version: '1',
      contractId: 'wiolett-core/v1',
      coreProtocolMajor: 1,
      stateSchemaVersion: 1,
      instanceId: 'test',
      startedAt: new Date().toISOString(),
      ...(supported ? { requestLimitsVersion: 1 } : {}),
    })
  );
  vi.stubGlobal('fetch', fetch);
  const service = new InferenceCoreBridgeService(
    { loadState: async () => row } as never,
    { open: () => ({ managementCredential: 'mock', dataCredential: 'mock' }) } as never
  );
  return { service, settings, fetch };
}

describe('managed core availability and request limits', () => {
  it('serves update_available and signs current limits without restarting core', async () => {
    const { service, settings, fetch } = harness(true);
    expect(await service.coreReady()).toBe(true);
    const first = await service.dataPlaneTarget();
    expect(first.requestLimits?.webSocketMaxPayloadBytes).toBe(256 * 1024 * 1024);
    settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 128 * 1024 * 1024;
    const next = await service.dataPlaneTarget();
    expect(next.requestLimits?.webSocketMaxPayloadBytes).toBe(128 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledOnce();
    const { claims } = newCoreRequestContext({
      tenantUserId: 'u',
      publicModelId: 'm',
      coreAccountId: 'a',
      coreModelId: 'm',
      operation: 'responses',
      requestLimits: next.requestLimits,
    });
    const headers = coreRequestHeaders(claims, 'mock');
    expect(JSON.parse(Buffer.from(headers['x-wiolett-context']!, 'base64url').toString()).requestLimits).toEqual(
      next.requestLimits
    );
  });
  it('keeps legacy strict contexts compatible', async () => {
    const { service } = harness(false);
    expect((await service.dataPlaneTarget()).requestLimits).toBeUndefined();
  });
  it('still fences an actual cutover', async () => {
    const { service, fetch } = harness(true, 'updating');
    await expect(service.dataPlaneTarget()).rejects.toMatchObject({ code: 'CORE_NOT_READY' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
