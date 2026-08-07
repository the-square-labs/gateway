import { describe, expect, it, vi } from 'vitest';
import type { RelayHealthResponse } from '@/grpc/relay-control.client.js';
import { RelayRecoverySafetyError } from './relay-docker-recovery.service.js';
import { RelayStartupFinalizerService } from './relay-startup-finalizer.service.js';

const health = (relayVersion = '1'): RelayHealthResponse => ({
  relayVersion,
  protocolVersion: 1,
  databaseContractVersion: 1,
  liveness: true,
  readiness: true,
  dataPlaneHealthy: true,
  appProxyHealthy: true,
  reason: '',
  lastHealthyAtUnixMs: '1',
});

function setup(responses: Array<RelayHealthResponse | Error>) {
  const client = {
    reloadIdentity: vi.fn().mockResolvedValue(true),
    getHealth: vi.fn(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('unreachable');
      return response;
    }),
  };
  const recovery = {
    ensureStarted: vi.fn().mockResolvedValue('already_running'),
    recreateExpected: vi.fn().mockResolvedValue('recreate'),
  };
  const finalizer = new RelayStartupFinalizerService(client, recovery as never, {
    required: true,
    expectedVersion: '1',
    readinessWaitMs: 5,
    readinessPollMs: 1,
    sleep: async () => {},
  });
  return { finalizer, client, recovery };
}

describe('RelayStartupFinalizerService', () => {
  it('does not touch a healthy relay with the expected contract version', async () => {
    const { finalizer, client, recovery } = setup([health()]);
    await expect(finalizer.finalize()).resolves.toEqual({ status: 'active', action: null, relayVersion: '1' });
    expect(client.reloadIdentity).toHaveBeenCalledOnce();
    expect(recovery.ensureStarted).not.toHaveBeenCalled();
    expect(recovery.recreateExpected).not.toHaveBeenCalled();
  });

  it('starts a missing relay and waits for readiness', async () => {
    const { finalizer, recovery } = setup([new Error('missing'), health()]);
    recovery.ensureStarted.mockResolvedValue('compose_up');
    await expect(finalizer.finalize()).resolves.toEqual({
      status: 'active',
      action: 'compose_up',
      relayVersion: '1',
    });
  });

  it('recreates an owned relay when the signed relay contract changes', async () => {
    const { finalizer, recovery } = setup([health('0'), health('1')]);
    await expect(finalizer.finalize()).resolves.toMatchObject({ status: 'active', action: 'recreate' });
    expect(recovery.recreateExpected).toHaveBeenCalledOnce();
  });

  it('uses the controlled recreation path for an old expected image', async () => {
    const { finalizer, recovery } = setup([new Error('down'), health('1')]);
    recovery.ensureStarted.mockRejectedValue(
      new RelayRecoverySafetyError('unexpected_image', 'old relay image is still running')
    );
    await expect(finalizer.finalize()).resolves.toMatchObject({ status: 'active', action: 'recreate' });
    expect(recovery.recreateExpected).toHaveBeenCalledOnce();
  });

  it('leaves the app startable when relay finalization fails', async () => {
    const { finalizer, recovery } = setup([new Error('down')]);
    recovery.ensureStarted.mockRejectedValue(new RelayRecoverySafetyError('ownership_unverified', 'manual deployment'));
    await expect(finalizer.finalize()).resolves.toEqual({
      status: 'degraded',
      action: null,
      reason: 'ownership_unverified',
    });
  });
});
