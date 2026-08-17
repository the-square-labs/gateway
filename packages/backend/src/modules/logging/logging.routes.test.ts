import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { loggingRoutes } from './logging.routes.js';
import { LoggingFeatureService } from './logging-feature.service.js';
import { LoggingMaintenanceService } from './logging-maintenance.service.js';
import { LoggingSchemaService } from './logging-schema.service.js';

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
};

const SCHEMA_1 = {
  id: 'schema-1',
  name: 'App',
  slug: 'app',
  description: null,
  schemaMode: 'reject',
  fieldSchema: [],
  createdById: USER.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SCHEMA_2 = { ...SCHEMA_1, id: 'schema-2', name: 'Audit', slug: 'audit' };

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/logging', loggingRoutes);
  return app;
}

function registerServices(
  scopes: string[],
  schemaService: Partial<LoggingSchemaService>,
  featureService: Partial<LoggingFeatureService> = { requireEnabled: vi.fn() }
) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn().mockResolvedValue({
      user: { ...USER, scopes },
      scopes,
      tokenId: 'token-1',
      tokenPrefix: 'gw_abc1234',
    }),
  } as unknown as TokensService);
  container.registerInstance(LoggingFeatureService, featureService as LoggingFeatureService);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
  container.registerInstance(LoggingSchemaService, schemaService as LoggingSchemaService);
}

function authHeaders() {
  return {
    Authorization: 'Bearer gw_valid',
    'Content-Type': 'application/json',
  };
}

afterEach(() => {
  container.reset();
});

describe('logging schema route permissions', () => {
  it('exposes logging health only with housekeeping view scope', async () => {
    registerServices(['housekeeping:view'], {});
    const snapshot = { configured: true, status: 'healthy', checkedAt: new Date().toISOString() };
    container.registerInstance(LoggingMaintenanceService, {
      getSnapshot: vi.fn().mockReturnValue(snapshot),
    } as unknown as LoggingMaintenanceService);

    const response = await createApp().request('/api/logging/health', { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: snapshot });
  });

  it('does not expose logging status without authentication', async () => {
    const response = await createApp().request('/api/logging/status');

    expect(response.status).toBe(401);
  });

  it('does not expose logging status to authenticated callers when logging is disabled', async () => {
    const requireEnabled = vi.fn(() => {
      throw new Error('should not run for removed status route');
    });
    registerServices([], {}, { requireEnabled });

    const response = await createApp().request('/api/logging/status', { headers: authHeaders() });

    expect(response.status).toBe(404);
    expect(requireEnabled).not.toHaveBeenCalled();
  });

  it('lists only resource-scoped schemas when the token lacks global schema list scope', async () => {
    registerServices(['logs:schemas:view:schema-1'], {
      list: vi.fn().mockResolvedValue([SCHEMA_1, SCHEMA_2]),
    });

    const response = await createApp().request('/api/logging/schemas', { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [SCHEMA_1] });
  });

  it('lists schemas with global schema view scope', async () => {
    registerServices(['logs:schemas:view'], {
      list: vi.fn().mockResolvedValue([SCHEMA_1, SCHEMA_2]),
    });

    const response = await createApp().request('/api/logging/schemas', { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [SCHEMA_1, SCHEMA_2] });
  });

  it('allows schema creation with logs:schemas:create', async () => {
    const create = vi.fn().mockResolvedValue(SCHEMA_1);
    registerServices(['logs:schemas:create'], { create });

    const response = await createApp().request('/api/logging/schemas', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'App', slug: 'app', schemaMode: 'reject', fieldSchema: [] }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({ name: 'App', schemaMode: 'reject', fieldSchema: [] }, USER.id);
  });

  it('allows resource-scoped schema reads by schema id', async () => {
    const get = vi.fn().mockResolvedValue(SCHEMA_1);
    registerServices(['logs:schemas:view:schema-1'], { get });

    const response = await createApp().request('/api/logging/schemas/schema-1', { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('schema-1');
  });
});
