import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { DashboardReadModelService } from './dashboard-read-model.service.js';
import { monitoringRoutes } from './monitoring.routes.js';
import { MonitoringService } from './monitoring.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
  authMethod: 'oidc',
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

const STATS = {
  proxyHosts: { total: 0, enabled: 0, online: 0, offline: 0, degraded: 0 },
  sslCertificates: { total: 0, active: 0, expiringSoon: 0, expired: 0 },
  pkiCertificates: { total: 0, active: 0, revoked: 0, expired: 0 },
  cas: { total: 0, active: 0 },
  nodes: { total: 0, online: 0, offline: 0, pending: 0 },
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/monitoring', monitoringRoutes);
  return app;
}

function registerSession(scopes: string[]) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes }]),
      },
    },
  } as unknown as DrizzleClient);
}

afterEach(() => {
  container.reset();
});

describe('dashboard bootstrap route', () => {
  it('uses hot projections and Docker snapshots rather than live managed-resource reads', async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const dashboardReadModels = {
      get: vi.fn(async (name: string) =>
        name === 'stats-user'
          ? { data: STATS, revision: 1, refreshStatus: 'success', availability: 'available' }
          : { data: [], revision: 1, refreshStatus: 'success', availability: 'available' }
      ),
    };
    const snapshots = {
      getList: vi.fn(async () => ({ data: [{ id: 'container-1', name: '/api' }], revision: 3 })),
    };
    const docker = {
      decorateContainerSnapshot: vi.fn(async () => [
        { id: 'container-1', name: '/api', state: 'running', scopeResourceId: 'container-1' },
      ]),
    };
    registerSession(['docker:containers:view']);
    container.registerInstance(DashboardReadModelService, dashboardReadModels as never);
    container.registerInstance(MonitoringService, {
      getDashboardStats: vi.fn(),
      getHealthOverview: vi.fn(),
    } as never);
    container.registerInstance(DockerSnapshotService, snapshots as never);
    container.registerInstance(DockerManagementService, docker as never);
    container.registerInstance(FinalizeSetupService, {
      getForUser: vi.fn(async () => null),
      shouldShowMfaReminder: vi.fn(async () => false),
    } as never);
    container.registerInstance(MfaService, {
      getStatus: vi.fn(async () => ({ totpConfigured: false, passkeyCount: 0 })),
      isGatewayMfaRequired: vi.fn(async () => false),
    } as never);
    container.registerInstance(AuthSettingsService, {
      getConfig: vi.fn(async () => ({ methods: { password: true, emailOtp: false } })),
    } as never);

    const response = await createApp().request('/api/monitoring/dashboard/bootstrap', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pins: {
          dashboard: { dockerResources: [{ id: 'container-1', nodeId, kind: 'container' }] },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(dashboardReadModels.get).toHaveBeenCalledWith('stats-user');
    expect(snapshots.getList).toHaveBeenCalledWith(nodeId, 'containers');
    expect(docker.decorateContainerSnapshot).toHaveBeenCalledWith(nodeId, [{ id: 'container-1', name: '/api' }]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        pinned: {
          dashboard: {
            dockerResources: [{ id: 'container-1', nodeId, name: 'api', state: 'running', kind: 'container' }],
          },
        },
      },
    });
  });

  it('builds resource-scoped stats from hot projections instead of repeating database aggregates', async () => {
    const dashboardReadModels = {
      get: vi.fn(async (name: string) => {
        if (name === 'proxies') {
          return {
            data: [
              { id: 'proxy-allowed', enabled: true, healthStatus: 'online' },
              { id: 'proxy-hidden', enabled: true, healthStatus: 'offline' },
            ],
            revision: 1,
          };
        }
        if (name === 'health') return { data: [], revision: 1 };
        return { data: [], revision: 1 };
      }),
    };
    const monitoring = {
      getDashboardStats: vi.fn(),
      getHealthOverview: vi.fn(),
    };
    registerSession(['proxy:view:proxy-allowed']);
    container.registerInstance(DashboardReadModelService, dashboardReadModels as never);
    container.registerInstance(MonitoringService, monitoring as never);
    container.registerInstance(FinalizeSetupService, {
      getForUser: vi.fn(async () => null),
      shouldShowMfaReminder: vi.fn(async () => false),
    } as never);
    container.registerInstance(MfaService, {
      getStatus: vi.fn(async () => ({ totpConfigured: false, passkeyCount: 0 })),
      isGatewayMfaRequired: vi.fn(async () => false),
    } as never);
    container.registerInstance(AuthSettingsService, {
      getConfig: vi.fn(async () => ({ methods: { password: true, emailOtp: false } })),
    } as never);

    const response = await createApp().request('/api/monitoring/dashboard/bootstrap', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(dashboardReadModels.get).toHaveBeenCalledWith('proxies');
    expect(monitoring.getDashboardStats).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      data: {
        stats: {
          proxyHosts: { total: 1, enabled: 1, online: 1, offline: 0, degraded: 0 },
        },
      },
    });
  });
});
