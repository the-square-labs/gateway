import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import type { InferenceCoreOperation, InferenceCoreStatus } from './inference-core.contract.js';
import { inferenceCoreLifecycleRoutes } from './inference-core.routes.js';
import { InferenceCoreRuntimeService } from './inference-core-runtime.service.js';

const ADMIN: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-admins',
  scopes: ['feat:ai:use', 'inference:providers:view', 'inference:providers:manage'],
  isBlocked: false,
};

const VIEWER: User = {
  ...ADMIN,
  id: '22222222-2222-4222-8222-222222222222',
  groupName: 'inference-viewers',
  scopes: ['feat:ai:use', 'inference:providers:view'],
};

function createDb(user: User) {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: user.id,
          oidcSubject: user.oidcSubject,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          groupId: user.groupId,
          additionalScopes: [],
          isBlocked: false,
        }),
      },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: user.groupId, parentId: null, name: user.groupName, scopes: user.scopes }]),
      },
    },
  };
}

function registerSession(user: User) {
  const session: SessionData = {
    userId: user.id,
    user,
    accessToken: 'oidc-access',
    csrfToken: 'csrf-token',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(session),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, createDb(user) as never);
}

const OPERATION: InferenceCoreOperation = {
  id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  kind: 'install',
  phase: 'resolving',
  status: 'running',
  progress: null,
  fromVersion: null,
  toVersion: '2.26.0-wiolett.1',
  fromDigest: null,
  toDigest: null,
  error: null,
  startedAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  finishedAt: null,
};

const STATUS: InferenceCoreStatus = {
  state: 'not_installed',
  installed: null,
  latest: null,
  compatibility: 'unknown',
  health: {
    status: 'unknown',
    version: null,
    coreProtocolMajor: null,
    stateSchemaVersion: null,
    checkedAt: null,
  },
  operation: null,
  lastError: null,
};

function registerRuntime(overrides: Partial<Record<keyof InferenceCoreRuntimeService, unknown>> = {}) {
  const runtime = {
    getStatus: vi.fn().mockResolvedValue(STATUS),
    install: vi.fn().mockResolvedValue(OPERATION),
    update: vi.fn().mockResolvedValue({ ...OPERATION, kind: 'update' }),
    repair: vi.fn().mockResolvedValue({ ...OPERATION, kind: 'repair' }),
    checkForUpdates: vi.fn().mockResolvedValue({
      version: '2.26.0-wiolett.1',
      digest: `sha256:${'ab'.repeat(32)}`,
      sizeBytes: 400_000_000,
      releaseNotesUrl: null,
    }),
    ...overrides,
  };
  container.registerInstance(InferenceCoreRuntimeService, runtime as unknown as InferenceCoreRuntimeService);
  return runtime;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/inference/core', inferenceCoreLifecycleRoutes);
  return app;
}

const sessionHeaders = { Cookie: 'session_id=session-1' };
const mutationHeaders = {
  ...sessionHeaders,
  'X-CSRF-Token': 'csrf-token',
  'Content-Type': 'application/json',
};

afterEach(() => container.reset());

describe('inference core lifecycle routes', () => {
  it('requires authentication for the status endpoint', async () => {
    registerRuntime();
    const response = await createApp().request('/api/inference/core/status');
    expect(response.status).toBe(401);
  });

  it('returns the lifecycle status for provider viewers', async () => {
    registerSession(VIEWER);
    registerRuntime();
    const response = await createApp().request('/api/inference/core/status', { headers: sessionHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(STATUS);
  });

  it('forbids install for provider viewers', async () => {
    registerSession(VIEWER);
    const runtime = registerRuntime();
    const response = await createApp().request('/api/inference/core/install', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('starts an install for provider managers and returns the operation', async () => {
    registerSession(ADMIN);
    const runtime = registerRuntime();
    const response = await createApp().request('/api/inference/core/install', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ version: '2.26.0-wiolett.1' }),
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { operation: InferenceCoreOperation }).operation.id).toBe(OPERATION.id);
    expect(runtime.install).toHaveBeenCalledWith('2.26.0-wiolett.1');
  });

  it('requires an explicit target version for update', async () => {
    registerSession(ADMIN);
    const runtime = registerRuntime();
    const response = await createApp().request('/api/inference/core/update', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(runtime.update).not.toHaveBeenCalled();
  });

  it('starts an update with a target version', async () => {
    registerSession(ADMIN);
    const runtime = registerRuntime();
    const response = await createApp().request('/api/inference/core/update', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ version: '2.26.0-wiolett.1' }),
    });
    expect(response.status).toBe(202);
    expect(runtime.update).toHaveBeenCalledWith('2.26.0-wiolett.1');
  });

  it('starts a repair', async () => {
    registerSession(ADMIN);
    const runtime = registerRuntime();
    const response = await createApp().request('/api/inference/core/repair', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(202);
    expect(runtime.repair).toHaveBeenCalledOnce();
  });

  it('checks the release channel and reports the latest release', async () => {
    registerSession(ADMIN);
    registerRuntime();
    const response = await createApp().request('/api/inference/core/check-updates', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { latest: { version: string } };
    expect(body.latest.version).toBe('2.26.0-wiolett.1');
  });

  it('stays reachable while the inference feature flag is off', async () => {
    const { inferenceFeatureGuard } = await import('@/app.js');
    registerSession(ADMIN);
    registerRuntime();
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(false),
    } as unknown as GeneralSettingsService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('/api/inference/*', inferenceFeatureGuard());
    app.route('/api/inference/core', inferenceCoreLifecycleRoutes);

    const status = await app.request('/api/inference/core/status', { headers: sessionHeaders });
    expect(status.status).toBe(200);
    const install = await app.request('/api/inference/core/install', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(202);
  });
});
