import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  cancelDockerMigrationRoute,
  createDockerMigrationRoute,
  getDockerMigrationRoute,
  listDockerMigrationsRoute,
  preflightDockerMigrationRoute,
  retryDockerMigrationCleanupRoute,
} from './docker-migration.docs.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationListQuerySchema,
  DockerMigrationPreflightInputSchema,
} from './docker-migration.schemas.js';
import { DockerMigrationService } from './docker-migration.service.js';

export function registerDockerMigrationRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(preflightDockerMigrationRoute, async (c) => {
    const body = DockerMigrationPreflightInputSchema.parse(await c.req.json());
    const data = await container
      .resolve(DockerMigrationService)
      .preflightMigration(body, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(createDockerMigrationRoute, async (c) => {
    const body = DockerMigrationCreateInputSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const data = await container.resolve(DockerMigrationService).create(body, user.id, c.get('effectiveScopes') ?? []);
    return c.json({ data }, 202);
  });

  router.openapi({ ...listDockerMigrationsRoute, middleware: requireScopeBase('docker:tasks') }, async (c) => {
    const query = DockerMigrationListQuerySchema.parse(c.req.query());
    const data = await container.resolve(DockerMigrationService).list(c.get('effectiveScopes') ?? [], query);
    return c.json({ data });
  });

  router.openapi({ ...getDockerMigrationRoute, middleware: requireScopeBase('docker:tasks') }, async (c) => {
    const data = await container
      .resolve(DockerMigrationService)
      .get(c.req.param('id')!, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi({ ...cancelDockerMigrationRoute, middleware: requireScopeBase('docker:tasks:manage') }, async (c) => {
    const data = await container
      .resolve(DockerMigrationService)
      .cancel(c.req.param('id')!, c.get('user')!.id, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(
    { ...retryDockerMigrationCleanupRoute, middleware: requireScopeBase('docker:tasks:manage') },
    async (c) => {
      const data = await container
        .resolve(DockerMigrationService)
        .retryCleanup(c.req.param('id')!, c.get('user')!.id, c.get('effectiveScopes') ?? []);
      return c.json({ data });
    }
  );
}
