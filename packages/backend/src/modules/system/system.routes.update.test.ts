import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  drizzleToken: Symbol('DrizzleClient'),
  updateService: {
    getCachedStatus: vi.fn(),
    prepareGatewayUpdate: vi.fn(),
    prepareRelayUpdate: vi.fn(),
    performUpdate: vi.fn(),
    performRelayUpdate: vi.fn(),
    startRelayUpdate: vi.fn(),
    completeRelayUpdate: vi.fn(),
    failRelayUpdate: vi.fn(),
    checkForUpdates: vi.fn(),
    isGatewayUpdateInProgress: vi.fn(),
    assertGatewayUpdateAllowed: vi.fn(),
    proceedWithoutWaiting: vi.fn(),
    acknowledgeGatewayUpdateFailure: vi.fn(),
    abandonRelayUpdate: vi.fn(),
  },
  daemonUpdateService: {
    getLatestRelease: vi.fn(),
    prepareTrustedDaemonUpdate: vi.fn(),
    markNodeUpdateInProgress: vi.fn().mockResolvedValue('operation-1'),
    trackNodeUpdateCompletion: vi.fn(),
    clearNodeUpdateInProgress: vi.fn(),
  },
  dispatch: {
    sendNodeExecCommand: vi.fn(),
    sendUpdateDaemonCommand: vi.fn(),
  },
  db: { select: vi.fn() },
  eventBus: { publish: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  TOKENS: { DrizzleClient: mocks.drizzleToken },
  container: {
    isRegistered: vi.fn().mockReturnValue(false),
    resolve: vi.fn((token) => {
      if (token === mocks.drizzleToken) return mocks.db;
      if (token?.name === 'EventBusService') return mocks.eventBus;
      if (token?.name === 'DaemonUpdateService') return mocks.daemonUpdateService;
      if (token?.name === 'NodeDispatchService') return mocks.dispatch;
      return mocks.updateService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', ['admin:update']);
    await next();
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  sessionOnly: async (_c: any, next: () => Promise<void>) => next(),
}));

import { systemRoutes } from './system.routes.js';

function app() {
  const router = new Hono<AppEnv>();
  router.onError(errorHandler);
  router.route('/', systemRoutes);
  return router;
}

describe('System RC update routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.updateService.prepareGatewayUpdate.mockResolvedValue({ imageRef: 'gateway@sha256:test' });
    mocks.updateService.prepareRelayUpdate.mockResolvedValue({ imageRef: 'relay@sha256:test' });
    mocks.updateService.isGatewayUpdateInProgress.mockReturnValue(false);
    mocks.updateService.assertGatewayUpdateAllowed.mockResolvedValue(undefined);
    mocks.updateService.acknowledgeGatewayUpdateFailure.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts a Gateway release candidate selected by the resolver', async () => {
    mocks.updateService.getCachedStatus.mockResolvedValue({
      updateAvailable: true,
      latestVersion: 'v2.10.0-rc.2',
      relay: { updateAvailable: false, latestVersion: null },
    });

    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateService.prepareGatewayUpdate).toHaveBeenCalledWith('v2.10.0-rc.2');
    // The new attempt supersedes a rolled-back one before sessions enter the update screen.
    expect(mocks.updateService.acknowledgeGatewayUpdateFailure.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.eventBus.publish.mock.invocationCallOrder[0]!
    );
  });

  it('refuses a second Gateway update while one is waiting or running', async () => {
    mocks.updateService.isGatewayUpdateInProgress.mockReturnValue(true);

    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
    expect(mocks.updateService.prepareGatewayUpdate).not.toHaveBeenCalled();
  });

  it('refuses a Gateway update while a Relay Pool update runs', async () => {
    mocks.updateService.assertGatewayUpdateAllowed.mockRejectedValue(
      new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', 'A Relay Pool update is in progress')
    );

    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'RELAY_UPDATE_IN_PROGRESS' });
    expect(mocks.updateService.prepareGatewayUpdate).not.toHaveBeenCalled();
    expect(mocks.eventBus.publish).not.toHaveBeenCalled();
  });

  it('refuses a Relay update while Gateway updates', async () => {
    mocks.updateService.isGatewayUpdateInProgress.mockReturnValue(true);

    const response = await app().request('/relay-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.3' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'GATEWAY_UPDATE_IN_PROGRESS' });
    expect(mocks.updateService.prepareRelayUpdate).not.toHaveBeenCalled();
    expect(mocks.updateService.startRelayUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin abandon a stuck Relay Pool update', async () => {
    mocks.updateService.abandonRelayUpdate.mockResolvedValueOnce({ targetVersion: 'v2.10.0-rc.3' });

    const response = await app().request('/relay-update/abandon', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.updateService.abandonRelayUpdate).toHaveBeenCalledWith('user-1');
    expect(mocks.eventBus.publish).toHaveBeenCalledWith(
      'system.update.changed',
      expect.objectContaining({ updating: false, component: 'relay', statusChanged: true })
    );
  });

  it('acknowledges a Gateway update that was rolled back', async () => {
    mocks.updateService.acknowledgeGatewayUpdateFailure.mockResolvedValueOnce(true);

    const response = await app().request('/update/acknowledge', { method: 'POST' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { acknowledged: true } });
  });

  it('lets an admin update now instead of waiting for running operations', async () => {
    mocks.updateService.proceedWithoutWaiting.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const proceeded = await app().request('/update/proceed', { method: 'POST' });
    expect(proceeded.status).toBe(200);
    await expect(proceeded.json()).resolves.toEqual({ data: { status: 'updating' } });

    const notWaiting = await app().request('/update/proceed', { method: 'POST' });
    expect(notWaiting.status).toBe(409);
    await expect(notWaiting.json()).resolves.toMatchObject({ code: 'UPDATE_NOT_WAITING' });
  });

  it('accepts a Relay release candidate selected by the resolver', async () => {
    mocks.updateService.getCachedStatus.mockResolvedValue({
      updateAvailable: false,
      latestVersion: null,
      relay: { updateAvailable: true, latestVersion: 'v2.10.0-rc.3' },
    });

    const response = await app().request('/relay-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.3' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateService.prepareRelayUpdate).toHaveBeenCalledWith('v2.10.0-rc.3');
  });

  it('rejects component-suffixed versions on Gateway update routes', async () => {
    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2-nginx' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.updateService.getCachedStatus).not.toHaveBeenCalled();
  });

  it('dispatches the signed daemon updater and marks the node update in progress', async () => {
    mocks.db.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ id: 'node-1', type: 'nginx', capabilities: { architecture: 'amd64' } }]),
        }),
      }),
    });
    mocks.daemonUpdateService.getLatestRelease.mockResolvedValue({
      tagName: 'v2.10.0-rc.27-nginx',
      version: 'v2.10.0-rc.27',
    });
    mocks.daemonUpdateService.prepareTrustedDaemonUpdate.mockResolvedValue({
      downloadUrl: 'https://updates.example/nginx-daemon',
      checksum: 'abc',
      signedManifest: 'manifest',
    });
    mocks.dispatch.sendUpdateDaemonCommand.mockResolvedValue({
      accepted: Promise.resolve(),
      result: Promise.resolve({ success: true }),
    });

    const response = await app().request('/daemon-updates/node-1', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.dispatch.sendUpdateDaemonCommand).toHaveBeenCalledOnce();
    expect(mocks.daemonUpdateService.markNodeUpdateInProgress).toHaveBeenCalledWith('node-1', 'v2.10.0-rc.27');
    expect(mocks.daemonUpdateService.trackNodeUpdateCompletion).toHaveBeenCalledWith(
      'node-1',
      'operation-1',
      expect.any(Promise)
    );
  });
});
