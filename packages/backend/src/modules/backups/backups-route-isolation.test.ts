import 'reflect-metadata';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { mcpRoutes } from '@/modules/mcp/mcp.routes.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv } from '@/types.js';
import { backupRoutes } from './backups.routes.js';

const databaseId = '11111111-1111-4111-8111-111111111111';
const apiResource = 'https://gateway.example.test/api';
const mcpResource = `${apiResource}/mcp`;
const validateAccessToken = vi.fn(async (_token: string, options: { resource?: string }) =>
  options.resource === mcpResource
    ? {
        user: { id: databaseId, scopes: ['mcp:use'] },
        scopes: ['nodes:details'],
        tokenId: 'mcp-token',
        tokenPrefix: 'gwo_fixture',
        clientId: 'fixture',
      }
    : null
);

function application() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  // Preserve the production mount point AND order, not just the isolated MCP router.
  app.route('/api', backupRoutes);
  app.route('/api/mcp', mcpRoutes);
  return app;
}

beforeEach(() => {
  validateAccessToken.mockClear();
  container.registerInstance(OAuthService, {
    getApiResourceUrl: () => apiResource,
    getMcpResourceUrl: () => mcpResource,
    getProtectedResourceMetadataUrl: () => 'https://gateway.example.test/.well-known/oauth-protected-resource/api/mcp',
    validateAccessToken,
  } as unknown as OAuthService);
  container.registerInstance(McpSettingsService, {
    getConfig: async () => ({ serverEnabled: true, extendedCompatibility: false }),
  } as unknown as McpSettingsService);
});
afterEach(() => container.reset());

describe('backup router authentication isolation', () => {
  it('lets an MCP resource token reach the real MCP handler without REST resource validation', async () => {
    const response = await application().request('/api/mcp', {
      method: 'GET',
      headers: { Authorization: 'Bearer gwo_fixture' },
    });
    // GET is deliberately unsupported by stateless MCP, but must pass MCP authentication.
    expect(response.status).toBe(405);
    expect(validateAccessToken).toHaveBeenCalledExactlyOnceWith('gwo_fixture', { resource: mcpResource });
  });

  it.each([
    ['/api/webhooks/docker/fixture', undefined],
    ['/api/webhooks/docker-source/fixture', undefined],
    ['/api/logging/ingest', 'Bearer gwl_fixture'],
    ['/api/logging/ingest/batch', 'Bearer gwl_fixture'],
    ['/api/pages-deploy/deployments', 'Bearer gwp_fixture'],
  ])('does not preempt the owning authentication handler of %s', async (path, authorization) => {
    const app = application();
    const owner = vi.fn();
    app.post(path!, (c) => {
      owner();
      return c.body(null, 204);
    });
    const response = await app.request(path!, {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
    });
    expect(response.status).toBe(204);
    expect(owner).toHaveBeenCalledOnce();
    expect(validateAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 'policies'],
    ['POST', 'policies'],
    ['PUT', `policies/${databaseId}`],
    ['DELETE', `policies/${databaseId}`],
    ['GET', 'runs'],
    ['POST', `policies/${databaseId}/runs`],
    ['POST', `runs/${databaseId}/restore`],
    ['POST', `runs/${databaseId}/cancel`],
    ['DELETE', `runs/${databaseId}`],
  ])('still requires authentication for %s backups/%s', async (method, path) => {
    const response = await application().request(`/api/databases/${databaseId}/backups/${path}`, { method });
    expect(response.status).toBe(401);
  });

  it('still rejects MCP resource tokens on REST backup routes', async () => {
    const response = await application().request(`/api/databases/${databaseId}/backups/policies`, {
      headers: { Authorization: 'Bearer gwo_fixture' },
    });
    expect(response.status).toBe(401);
    expect(validateAccessToken).toHaveBeenCalledExactlyOnceWith('gwo_fixture', { resource: apiResource });
  });
});
