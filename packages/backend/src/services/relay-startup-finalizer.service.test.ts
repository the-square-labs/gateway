import { describe, expect, it, vi } from 'vitest';
import type { RelayHealthResponse } from '@/grpc/relay-control.client.js';
import { RelayRecoverySafetyError } from './relay-docker-recovery.service.js';
import { RelayStartupFinalizerService } from './relay-startup-finalizer.service.js';

const health = (buildVersion = '1'): RelayHealthResponse => ({
  buildVersion,
  protocolMajor: 1,
  appliedRevision: '1',
  keyIds: ['key-1'],
  registeredEndpoints: '0',
  activeTunnels: '0',
  liveness: true,
  readiness: true,
  reason: '',
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
    await expect(finalizer.finalize()).resolves.toEqual({ status: 'active', action: null, buildVersion: '1' });
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
      buildVersion: '1',
    });
  });

  it('recreates an owned relay when the signed relay contract changes', async () => {
    const { finalizer, recovery } = setup([health('0'), health('1')]);
    await expect(finalizer.finalize()).resolves.toMatchObject({ status: 'active', action: 'recreate' });
    expect(recovery.recreateExpected).toHaveBeenCalledOnce();
  });

  it('recreates an owned relay when the protocol major is incompatible', async () => {
    const { finalizer, recovery } = setup([{ ...health(), protocolMajor: 2 }, health()]);
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

  it('recreates an owned running relay when persisted identity no longer authenticates', async () => {
    const { finalizer, client, recovery } = setup([]);
    client.getHealth.mockImplementation(async () => {
      if (recovery.recreateExpected.mock.calls.length > 0) return health('1');
      throw new Error('tls unavailable');
    });
    await expect(finalizer.finalize()).resolves.toMatchObject({ status: 'active', action: 'recreate' });
    expect(recovery.ensureStarted).toHaveBeenCalledOnce();
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
