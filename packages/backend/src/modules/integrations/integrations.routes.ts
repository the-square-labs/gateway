import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { ExternalSshService } from './external-ssh.service.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import {
  authorizeGitLabUserCredentialRoute,
  createCloudflareConnectorRoute,
  createGitLabConnectorRoute,
  deleteCloudflareConnectorRoute,
  deleteGitLabConnectorRoute,
  disconnectGitLabUserCredentialRoute,
  getCloudflareConnectorRoute,
  getGitLabConnectorCapabilitiesRoute,
  getGitLabConnectorRoute,
  getGitLabUserCredentialRoute,
  listCloudflareConnectorsRoute,
  listCloudflareZonesRoute,
  listGitLabAllowlistOptionsRoute,
  listGitLabConnectorsRoute,
  previewCloudflareConnectorTestRoute,
  previewGitLabAllowlistRoute,
  previewGitLabConnectorTestRoute,
  refreshGitLabAllowlistOptionsRoute,
  rotateCloudflareConnectorTokenRoute,
  rotateGitLabConnectorTokenRoute,
  searchGitLabAllowlistRoute,
  syncCloudflareConnectorRoute,
  syncGitLabConnectorRoute,
  testCloudflareConnectorRoute,
  testGitLabConnectorRoute,
  updateCloudflareConnectorRoute,
  updateGitLabConnectorRoute,
} from './integrations.docs.js';
import {
  CloudflareConnectorCreateSchema,
  CloudflareConnectorListQuerySchema,
  CloudflareConnectorPreviewTestSchema,
  CloudflareConnectorRotateTokenSchema,
  CloudflareConnectorUpdateSchema,
  GitConnectorCreateSchema,
  GitConnectorPreviewTestSchema,
  GitConnectorUpdateSchema,
  GitHubConnectorCreateSchema,
  GitHubConnectorPreviewTestSchema,
  GitHubOAuthStartSchema,
  GitLabAllowlistPreviewSearchSchema,
  GitLabAllowlistSearchQuerySchema,
  GitLabConnectorCreateSchema,
  GitLabConnectorListQuerySchema,
  GitLabConnectorPreviewTestSchema,
  GitLabConnectorRotateTokenSchema,
  GitLabConnectorUpdateSchema,
  GitLabUserCredentialAuthorizeSchema,
  GitUserCredentialAuthorizeSchema,
} from './integrations.schemas.js';
import { IntegrationsService } from './integrations.service.js';

export const integrationsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

integrationsRoutes.use('*', authMiddleware);

const requireGitLabUserCredentialAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  await sessionOnly(c, async () => {
    await requireScope('feat:ai:use')(c, next);
  });
};

function requireGitLabOperation(
  operation: string,
  requiredScope: string | readonly string[]
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')!;
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: c.get('effectiveScopes') ?? user.scopes },
      provider: 'gitlab',
      connectorId: c.req.param('id') ?? null,
      operation,
      requiredScope,
    });
    await next();
  };
}

function requireCloudflareOperation(
  operation: string,
  requiredScope: string | readonly string[]
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')!;
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: c.get('effectiveScopes') ?? user.scopes },
      provider: 'cloudflare',
      connectorId: c.req.param('id') ?? null,
      operation,
      requiredScope,
    });
    await next();
  };
}

function requireGitOperation(
  provider: 'github' | 'git' | 'ssh',
  requiredScope: string | readonly string[]
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')!;
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: c.get('effectiveScopes') ?? user.scopes },
      provider,
      connectorId: c.req.param('id') ?? null,
      operation: `connector.${c.req.method.toLowerCase()}`,
      requiredScope,
    });
    await next();
  };
}

integrationsRoutes.get(
  '/github/oauth',
  requireGitOperation('github', ['integrations:github:view', 'integrations:github:manage']),
  async (c) => c.json({ data: container.resolve(IntegrationsService).getGitHubOAuthAvailability() })
);

integrationsRoutes.post(
  '/github/oauth/sessions',
  requireGitOperation('github', 'integrations:github:manage'),
  async (c) => {
    const input = GitHubOAuthStartSchema.parse(await c.req.json());
    const data = await container.resolve(IntegrationsService).startGitHubOAuth(input, c.get('user')!.id);
    return c.json({ data }, 201);
  }
);

integrationsRoutes.get(
  '/github/oauth/sessions/:id',
  requireGitOperation('github', 'integrations:github:manage'),
  async (c) => {
    const data = await container
      .resolve(IntegrationsService)
      .getGitHubOAuthStatus(c.req.param('id'), c.get('user')!.id);
    return c.json({ data });
  }
);

integrationsRoutes.delete(
  '/github/oauth/sessions/:id',
  requireGitOperation('github', 'integrations:github:manage'),
  async (c) => {
    const data = await container.resolve(IntegrationsService).cancelGitHubOAuth(c.req.param('id'), c.get('user')!.id);
    return c.json({ data });
  }
);

integrationsRoutes.post(
  '/github/connectors/preview-test',
  requireGitOperation('github', 'integrations:github:manage'),
  async (c) => {
    const input = GitHubConnectorPreviewTestSchema.parse(await c.req.json());
    const data = await container.resolve(IntegrationsService).previewGitHubConnectorTest(input);
    return c.json({ data });
  }
);

integrationsRoutes.post(
  '/git/connectors/preview-test',
  requireGitOperation('git', 'integrations:git:manage'),
  async (c) => {
    const input = GitConnectorPreviewTestSchema.parse(await c.req.json());
    const data = await container.resolve(IntegrationsService).previewGitConnectorTest(input);
    return c.json({ data });
  }
);

for (const provider of ['github', 'git'] as const) {
  const scopeBase = `integrations:${provider}`;
  integrationsRoutes.get(
    `/${provider}/connectors`,
    requireGitOperation(provider, [`${scopeBase}:view`, `${scopeBase}:manage`]),
    async (c) => {
      const enabled = c.req.query('enabled');
      const service = container.resolve(IntegrationsService);
      return c.json({
        data: await service.listGitConnectors(provider, enabled === undefined ? undefined : enabled === 'true'),
      });
    }
  );
  integrationsRoutes.post(
    `/${provider}/connectors`,
    requireGitOperation(provider, `${scopeBase}:manage`),
    async (c) => {
      const input =
        provider === 'github'
          ? GitHubConnectorCreateSchema.parse(await c.req.json())
          : GitConnectorCreateSchema.parse(await c.req.json());
      const data = await container.resolve(IntegrationsService).createGitConnector(provider, input, c.get('user')!.id);
      return c.json({ data }, 201);
    }
  );
  integrationsRoutes.patch(
    `/${provider}/connectors/:id`,
    requireGitOperation(provider, `${scopeBase}:manage`),
    async (c) => {
      const input = GitConnectorUpdateSchema.parse(await c.req.json());
      const data = await container
        .resolve(IntegrationsService)
        .updateGitConnector(provider, c.req.param('id'), input, c.get('user')!.id);
      return c.json({ data });
    }
  );
  integrationsRoutes.post(
    `/${provider}/connectors/:id/test`,
    requireGitOperation(provider, `${scopeBase}:manage`),
    async (c) => {
      const data = await container
        .resolve(IntegrationsService)
        .testGitConnector(provider, c.req.param('id'), c.get('user')!.id);
      return c.json({ data });
    }
  );
  integrationsRoutes.post(
    `/${provider}/connectors/:id/sync`,
    requireGitOperation(provider, `${scopeBase}:manage`),
    async (c) => {
      const data = await container
        .resolve(IntegrationsService)
        .syncGitConnector(provider, c.req.param('id'), c.get('user')!.id);
      return c.json({ data });
    }
  );
  integrationsRoutes.delete(
    `/${provider}/connectors/:id`,
    requireGitOperation(provider, `${scopeBase}:manage`),
    async (c) => {
      await container.resolve(IntegrationsService).deleteGitConnector(provider, c.req.param('id'), c.get('user')!.id);
      return c.json({ success: true });
    }
  );
  integrationsRoutes.get(
    `/${provider}/connectors/:id/user-credential`,
    requireGitLabUserCredentialAccess,
    async (c) => {
      const data = await container
        .resolve(IntegrationsService)
        .getGitUserCredentialStatus(provider, c.req.param('id'), c.get('user')!.id);
      return c.json({ data });
    }
  );
  integrationsRoutes.post(
    `/${provider}/connectors/:id/user-credential`,
    requireGitLabUserCredentialAccess,
    async (c) => {
      const input = GitUserCredentialAuthorizeSchema.parse(await c.req.json());
      const data = await container
        .resolve(IntegrationsService)
        .authorizeGitUserCredential(provider, c.req.param('id'), c.get('user')!.id, input);
      return c.json({ data });
    }
  );
  integrationsRoutes.delete(
    `/${provider}/connectors/:id/user-credential`,
    requireGitLabUserCredentialAccess,
    async (c) => {
      const data = await container
        .resolve(IntegrationsService)
        .disconnectGitUserCredential(provider, c.req.param('id'), c.get('user')!.id);
      return c.json({ data });
    }
  );
}

integrationsRoutes.get(
  '/ssh/connectors',
  requireGitOperation('ssh', ['integrations:ssh:view', 'integrations:ssh:manage']),
  async (c) => {
    return c.json({ data: await container.resolve(ExternalSshService).list(c.get('user')!) });
  }
);

integrationsRoutes.post(
  '/ssh/connectors/host-key',
  requireGitOperation('ssh', 'integrations:ssh:manage'),
  async (c) => {
    const input = z
      .object({
        host: z.string().trim().min(1).max(255),
        port: z.number().int().min(1).max(65535).optional(),
        jumpConnectorId: z.string().uuid().nullable().optional(),
      })
      .parse(await c.req.json());
    return c.json({
      data: await container.resolve(ExternalSshService).discoverHostKey(c.get('user')!, input, c.req.raw.signal),
    });
  }
);

integrationsRoutes.post('/ssh/connectors', requireGitOperation('ssh', 'integrations:ssh:manage'), async (c) => {
  const body = await c.req.json();
  const input = z
    .object({
      name: z.string().trim().min(1).max(255),
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().trim().min(1).max(255),
      authMethod: z.enum(['password', 'private_key']),
      secret: z.string().max(16_384).optional(),
      hostFingerprint: z.string().trim().min(1).max(255),
      jumpConnectorId: z.string().uuid().nullable().optional(),
      enabled: z.boolean().optional(),
      generatePrivateKey: z.boolean().optional(),
      reuseCredentialFromConnectorId: z.string().uuid().optional(),
    })
    .parse(body);
  return c.json({ data: await container.resolve(ExternalSshService).create(c.get('user')!, input) }, 201);
});

integrationsRoutes.post(
  '/ssh/connectors/:id/test',
  requireGitOperation('ssh', 'integrations:ssh:manage'),
  async (c) => {
    return c.json({
      data: await container.resolve(ExternalSshService).test(c.get('user')!, c.req.param('id'), c.req.raw.signal),
    });
  }
);

integrationsRoutes.post(
  '/ssh/connectors/:id/sync',
  requireGitOperation('ssh', 'integrations:ssh:manage'),
  async (c) => {
    return c.json({
      data: await container.resolve(ExternalSshService).test(c.get('user')!, c.req.param('id'), c.req.raw.signal),
    });
  }
);

integrationsRoutes.patch('/ssh/connectors/:id', requireGitOperation('ssh', 'integrations:ssh:manage'), async (c) => {
  const input = z
    .object({ name: z.string().trim().min(1).max(255) })
    .strict()
    .parse(await c.req.json());
  return c.json({
    data: await container.resolve(ExternalSshService).updateName(c.get('user')!, c.req.param('id'), input.name),
  });
});

integrationsRoutes.delete('/ssh/connectors/:id', requireGitOperation('ssh', 'integrations:ssh:manage'), async (c) => {
  return c.json({ data: await container.resolve(ExternalSshService).delete(c.get('user')!, c.req.param('id')) });
});

integrationsRoutes.openapi(
  {
    ...listGitLabConnectorsRoute,
    middleware: requireGitLabOperation('connector.list', ['integrations:gitlab:view', 'integrations:gitlab:manage']),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const query = GitLabConnectorListQuerySchema.parse(c.req.query());
    const data = await service.listGitLabConnectors(query);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...listCloudflareConnectorsRoute,
    middleware: requireCloudflareOperation('connector.list', [
      'integrations:cloudflare:view',
      'integrations:cloudflare:manage',
    ]),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const query = CloudflareConnectorListQuerySchema.parse(c.req.query());
    const data = await service.listCloudflareConnectors(query);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...createCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.create', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = CloudflareConnectorCreateSchema.parse(await c.req.json());
    const data = await service.createCloudflareConnector(input, user.id);
    return c.json({ data }, 201);
  }
);

integrationsRoutes.openapi(
  {
    ...previewCloudflareConnectorTestRoute,
    middleware: requireCloudflareOperation('connector.preview_test', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const input = CloudflareConnectorPreviewTestSchema.parse(await c.req.json());
    const data = await service.testCloudflareConnectorPreview(input);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...getCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.get', [
      'integrations:cloudflare:view',
      'integrations:cloudflare:manage',
    ]),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const data = await service.getCloudflareConnector(c.req.param('id')!);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...updateCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.update', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = CloudflareConnectorUpdateSchema.parse(await c.req.json());
    const data = await service.updateCloudflareConnector(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...deleteCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.delete', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    await service.deleteCloudflareConnector(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

integrationsRoutes.openapi(
  {
    ...rotateCloudflareConnectorTokenRoute,
    middleware: requireCloudflareOperation('connector.token.rotate', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = CloudflareConnectorRotateTokenSchema.parse(await c.req.json());
    const data = await service.rotateCloudflareConnectorToken(c.req.param('id')!, input.token, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...testCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.test', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.testCloudflareConnector(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...syncCloudflareConnectorRoute,
    middleware: requireCloudflareOperation('connector.sync', 'integrations:cloudflare:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.syncCloudflareConnector(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...listCloudflareZonesRoute,
    middleware: requireCloudflareOperation('connector.zones.list', [
      'integrations:cloudflare:view',
      'integrations:cloudflare:manage',
    ]),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const data = await service.listCloudflareZones(c.req.param('id')!);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...createGitLabConnectorRoute,
    middleware: requireGitLabOperation('connector.create', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = GitLabConnectorCreateSchema.parse(await c.req.json());
    const data = await service.createGitLabConnector(input, user.id);
    return c.json({ data }, 201);
  }
);

integrationsRoutes.openapi(
  {
    ...previewGitLabConnectorTestRoute,
    middleware: requireGitLabOperation('connector.preview_test', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const input = GitLabConnectorPreviewTestSchema.parse(await c.req.json());
    const data = await service.testGitLabConnectorPreview(input);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...previewGitLabAllowlistRoute,
    middleware: requireGitLabOperation('connector.allowlist.preview_search', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const input = GitLabAllowlistPreviewSearchSchema.parse(await c.req.json());
    const data = await service.searchGitLabAllowlistPreview(input);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...getGitLabConnectorRoute,
    middleware: requireGitLabOperation('connector.get', ['integrations:gitlab:view', 'integrations:gitlab:manage']),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const data = await service.getGitLabConnector(c.req.param('id')!);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...updateGitLabConnectorRoute,
    middleware: requireGitLabOperation('connector.update', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = GitLabConnectorUpdateSchema.parse(await c.req.json());
    const data = await service.updateGitLabConnector(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...deleteGitLabConnectorRoute,
    middleware: requireGitLabOperation('connector.delete', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    await service.deleteGitLabConnector(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

integrationsRoutes.openapi(
  {
    ...rotateGitLabConnectorTokenRoute,
    middleware: requireGitLabOperation('connector.token.rotate', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = GitLabConnectorRotateTokenSchema.parse(await c.req.json());
    const data = await service.rotateGitLabConnectorToken(c.req.param('id')!, input.token, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...getGitLabConnectorCapabilitiesRoute,
    middleware: requireGitLabOperation('connector.capabilities.get', [
      'integrations:gitlab:view',
      'integrations:gitlab:manage',
    ]),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const data = await service.getGitLabConnectorCapabilities(c.req.param('id')!);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  { ...testGitLabConnectorRoute, middleware: requireGitLabOperation('connector.test', 'integrations:gitlab:manage') },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.testGitLabConnector(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  { ...syncGitLabConnectorRoute, middleware: requireGitLabOperation('connector.sync', 'integrations:gitlab:sync') },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.syncGitLabConnector(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  { ...getGitLabUserCredentialRoute, middleware: requireGitLabUserCredentialAccess },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.getGitLabUserCredentialStatus(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  { ...authorizeGitLabUserCredentialRoute, middleware: requireGitLabUserCredentialAccess },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const input = GitLabUserCredentialAuthorizeSchema.parse(await c.req.json());
    const data = await service.authorizeGitLabUserCredential(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  { ...disconnectGitLabUserCredentialRoute, middleware: requireGitLabUserCredentialAccess },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.disconnectGitLabUserCredential(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...searchGitLabAllowlistRoute,
    middleware: requireGitLabOperation('connector.allowlist.search', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const query = GitLabAllowlistSearchQuerySchema.parse(c.req.query());
    const data = await service.searchGitLabAllowlist(c.req.param('id')!, query.q);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...listGitLabAllowlistOptionsRoute,
    middleware: requireGitLabOperation('connector.allowlist.options', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const data = await service.listGitLabAllowlistOptions(c.req.param('id')!);
    return c.json({ data });
  }
);

integrationsRoutes.openapi(
  {
    ...refreshGitLabAllowlistOptionsRoute,
    middleware: requireGitLabOperation('connector.allowlist.options.refresh', 'integrations:gitlab:manage'),
  },
  async (c) => {
    const service = container.resolve(IntegrationsService);
    const user = c.get('user')!;
    const data = await service.refreshGitLabAllowlistOptions(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);
