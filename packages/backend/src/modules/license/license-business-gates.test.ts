import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSchemaService } from '@/modules/logging/logging-schema.service.js';
import { LoggingTokenService } from '@/modules/logging/logging-token.service.js';

function deniedPolicy() {
  const error = new Error('license denied');
  return {
    error,
    hasFeature: vi.fn().mockResolvedValue(false),
    requireFeature: vi.fn(async () => Promise.reject(error)),
  };
}

describe('Business entitlement service boundaries', () => {
  it('gates Secure Runtime setup before looking up the Docker node', async () => {
    const service = new DockerManagementService({} as never, {} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.manageRunsc('node', 'preflight')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('secure-runtime');
  });

  it('gates enabling structured logging before persisting settings', async () => {
    const settings = { saveConfig: vi.fn() };
    const service = new LoggingRuntimeService(settings as never, {} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.update({ mode: 'local' })).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('structured-logging');
    expect(settings.saveConfig).not.toHaveBeenCalled();
  });

  it('allows structured logging to be disabled after entitlement loss', async () => {
    const runtime = {
      mode: 'disabled' as const,
      url: '',
      username: '',
      password: '',
      database: 'gateway',
      table: 'events',
      requestTimeoutMs: 10_000,
    };
    const settings = {
      saveConfig: vi.fn().mockResolvedValue(runtime),
      getPublicConfig: vi.fn().mockResolvedValue({ ...runtime, password: undefined, passwordLast4: null }),
    };
    const local = { reconcile: vi.fn().mockResolvedValue(undefined) };
    const storage = { configure: vi.fn().mockResolvedValue(undefined) };
    const feature = { markUnavailable: vi.fn() };
    const service = new LoggingRuntimeService(settings as never, local as never, storage as never, feature as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.update({ mode: 'disabled' })).resolves.toMatchObject({ mode: 'disabled' });
    expect(policy.requireFeature).not.toHaveBeenCalled();
    expect(feature.markUnavailable).toHaveBeenCalledWith('Structured logging is disabled');
  });

  it('gates new structured logging environments', async () => {
    const service = new LoggingEnvironmentService({} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create({} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('structured-logging');
  });

  it('gates new structured logging schemas', async () => {
    const service = new LoggingSchemaService({} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create({} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('structured-logging');
  });

  it('gates new structured logging tokens', async () => {
    const service = new LoggingTokenService({} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create('environment', {} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('structured-logging');
  });
});
