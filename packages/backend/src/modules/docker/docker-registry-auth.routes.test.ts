import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { __testOnly, dockerRegistryAuthRoutes } from './docker-registry-auth.routes.js';
import { DockerInternalRegistryService } from './docker-registry-internal.service.js';

afterEach(() => container.reset());

describe('docker registry external token request parsing', () => {
  it('accepts a Gateway API token only as the Basic password', () => {
    expect(__testOnly.basicPassword(`Basic ${Buffer.from('gateway:gw_secret').toString('base64')}`)).toBe('gw_secret');
    expect(__testOnly.basicPassword(`Basic ${Buffer.from('gateway:gwo_oauth').toString('base64')}`)).toBeNull();
    expect(__testOnly.basicPassword('Bearer gw_secret')).toBeNull();
  });

  it('parses exact repository pull/push grants and rejects delete or malformed repositories', () => {
    const valid = new URL(
      'https://gateway.example.com/api/docker/registry/token?scope=repository:tenant/app:pull,push'
    );
    expect(__testOnly.requestedRegistryGrants(valid)).toEqual([
      { repository: 'tenant/app', actions: ['pull', 'push'] },
    ]);

    const deletion = new URL(
      'https://gateway.example.com/api/docker/registry/token?scope=repository:tenant/app:delete'
    );
    expect(() => __testOnly.requestedRegistryGrants(deletion)).toThrow('Registry action scope is invalid');

    const malformed = new URL('https://gateway.example.com/api/docker/registry/token?scope=repository:Tenant/App:pull');
    expect(() => __testOnly.requestedRegistryGrants(malformed)).toThrow('Registry repository scope is invalid');
  });

  it('maps API-token registry view/edit scopes to pull/push token grants', async () => {
    const token = {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1' },
        scopes: ['docker:registries:internal:pull:tenant/app', 'docker:registries:internal:push:tenant/app'],
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    };
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn().mockReturnValue({
        token: 'jwt',
        accessToken: 'jwt',
        expiresIn: 300,
        issuedAt: '2026-08-24T00:00:00.000Z',
      }),
    };
    container.registerInstance(TokensService, token as never);
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request(
      '/registry/token?service=gateway-internal-registry&scope=repository:tenant/app:pull,push',
      {
        headers: { Authorization: `Basic ${Buffer.from('gateway:gw_secret').toString('base64')}` },
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'jwt', access_token: 'jwt', expires_in: 300 });
    expect(registry.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: [{ repository: 'tenant/app', actions: ['pull', 'push'] }],
        allowed: [{ repository: 'tenant/app', actions: ['pull', 'push'] }],
      })
    );
  });

  it('denies push when the API token is pull-only', async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1' },
        scopes: ['docker:registries:internal:pull:tenant/app'],
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as never);
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn(),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request('/registry/token?scope=repository:tenant/app:push', {
      headers: { Authorization: `Basic ${Buffer.from('gateway:gw_secret').toString('base64')}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'REGISTRY_SCOPE_DENIED' });
    expect(registry.issueToken).not.toHaveBeenCalled();
  });

  it('rejects external token issuance before API-token validation when Business is unavailable', async () => {
    const validateToken = vi.fn();
    container.registerInstance(TokensService, { validateToken } as never);
    const registry = {
      assertExternalAccessEntitled: vi
        .fn()
        .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required')),
      issueToken: vi.fn(),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request('/registry/token?scope=repository:tenant/app:pull', {
      headers: { Authorization: `Basic ${Buffer.from('gateway:gw_secret').toString('base64')}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(validateToken).not.toHaveBeenCalled();
    expect(registry.issueToken).not.toHaveBeenCalled();
  });
});
