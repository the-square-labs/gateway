import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
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
  },
  daemonUpdateService: {
    getLatestRelease: vi.fn(),
    prepareTrustedDaemonUpdate: vi.fn(),
    markNodeUpdateInProgress: vi.fn(),
    trackNodeUpdateCompletion: vi.fn(),
    clearNodeUpdateInProgress: vi.fn(),
  },
  dispatch: {
    prepareRelaySupervisorRollbackBootstrap: vi.fn(),
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

  it('prepares the legacy Relay runner before marking a generic node update in progress', async () => {
    mocks.db.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ id: 'node-1', type: 'relay', capabilities: { architecture: 'amd64' } }]),
        }),
      }),
    });
    mocks.daemonUpdateService.getLatestRelease.mockResolvedValue({
      tagName: 'v2.10.0-rc.21-relay',
      version: 'v2.10.0-rc.21',
    });
    mocks.daemonUpdateService.prepareTrustedDaemonUpdate.mockResolvedValue({
      downloadUrl: 'https://updates.example/relay-supervisor',
      checksum: 'abc',
      signedManifest: 'manifest',
    });
    mocks.dispatch.sendUpdateDaemonCommand.mockResolvedValue({
      accepted: Promise.resolve(),
      result: Promise.resolve({ success: true }),
    });

    const response = await app().request('/daemon-updates/node-1', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.dispatch.prepareRelaySupervisorRollbackBootstrap).toHaveBeenCalledWith('node-1');
    expect(mocks.dispatch.prepareRelaySupervisorRollbackBootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.daemonUpdateService.markNodeUpdateInProgress.mock.invocationCallOrder[0]!
    );
  });
});
