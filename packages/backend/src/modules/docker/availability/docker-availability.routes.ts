import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  disableDockerAvailabilityRoute,
  enableDockerAvailabilityRoute,
  getDockerAvailabilityByResourceRoute,
  getDockerAvailabilityRoute,
  listDockerAvailabilityOperationsPageRoute,
  listDockerAvailabilityOperationsRoute,
  preflightDockerAvailabilityRoute,
  retryDockerAvailabilityOperationRoute,
  updateDockerAvailabilityRoute,
} from './docker-availability.docs.js';
import {
  DockerAvailabilityByResourceQuerySchema,
  DockerAvailabilityDisableInputSchema,
  DockerAvailabilityOperationIdSchema,
  DockerAvailabilityOperationsQuerySchema,
  DockerAvailabilityPolicyIdSchema,
  DockerAvailabilityPolicyInputSchema,
  DockerAvailabilityPolicyUpdateSchema,
  dockerAvailabilityResourceFromQuery,
} from './docker-availability.schemas.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

export function registerDockerAvailabilityRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(preflightDockerAvailabilityRoute, async (c) => {
    const input = DockerAvailabilityPolicyInputSchema.parse(await c.req.json());
    const data = await container.resolve(DockerAvailabilityService).preflight(input, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(
    { ...enableDockerAvailabilityRoute, middleware: requireScopeBase('docker:availability:manage') },
    async (c) => {
      const input = DockerAvailabilityPolicyInputSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerAvailabilityService)
        .enable(input, c.get('user')!.id, c.get('effectiveScopes') ?? []);
      return c.json({ data }, 202);
    }
  );

  router.openapi(getDockerAvailabilityByResourceRoute, async (c) => {
    const resource = dockerAvailabilityResourceFromQuery(DockerAvailabilityByResourceQuerySchema.parse(c.req.query()));
    const data = await container
      .resolve(DockerAvailabilityService)
      .getByResource(resource, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(getDockerAvailabilityRoute, async (c) => {
    const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
    const data = await container.resolve(DockerAvailabilityService).get(policyId, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(listDockerAvailabilityOperationsRoute, async (c) => {
    const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
    const data = await container
      .resolve(DockerAvailabilityService)
      .listOperations(policyId, c.get('effectiveScopes') ?? []);
    return c.json({ data });
  });

  router.openapi(listDockerAvailabilityOperationsPageRoute, async (c) => {
    const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
    const query = DockerAvailabilityOperationsQuerySchema.parse(c.req.query());
    const result = await container
      .resolve(DockerAvailabilityService)
      .listOperationsPage(policyId, c.get('effectiveScopes') ?? [], query.page, query.limit);
    return c.json(result);
  });

  router.openapi(
    { ...updateDockerAvailabilityRoute, middleware: requireScopeBase('docker:availability:manage') },
    async (c) => {
      const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
      const input = DockerAvailabilityPolicyUpdateSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerAvailabilityService)
        .update(policyId, input, c.get('user')!.id, c.get('effectiveScopes') ?? []);
      return c.json({ data }, 202);
    }
  );

  router.openapi(
    { ...disableDockerAvailabilityRoute, middleware: requireScopeBase('docker:availability:manage') },
    async (c) => {
      const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
      const input = DockerAvailabilityDisableInputSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerAvailabilityService)
        .disable(policyId, input, c.get('user')!.id, c.get('effectiveScopes') ?? []);
      return c.json({ data }, 202);
    }
  );

  router.openapi(
    { ...retryDockerAvailabilityOperationRoute, middleware: requireScopeBase('docker:availability:manage') },
    async (c) => {
      const policyId = DockerAvailabilityPolicyIdSchema.parse(c.req.param('id'));
      const operationId = DockerAvailabilityOperationIdSchema.parse(c.req.param('operationId'));
      const data = await container
        .resolve(DockerAvailabilityService)
        .retryOperation(policyId, operationId, c.get('user')!.id, c.get('effectiveScopes') ?? []);
      return c.json({ data }, 202);
    }
  );
}
