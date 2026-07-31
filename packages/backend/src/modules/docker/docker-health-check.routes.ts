import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import {
  containerHealthCheckRoute,
  deploymentHealthCheckRoute,
  testContainerHealthCheckRoute,
  testDeploymentHealthCheckRoute,
  upsertContainerHealthCheckRoute,
  upsertDeploymentHealthCheckRoute,
} from './docker.docs.js';
import { DockerHealthCheckUpsertSchema } from './docker.schemas.js';
import { requireDockerContainerScope, requireDockerDeploymentScope } from './docker-access.middleware.js';
import { DockerHealthCheckService } from './docker-health-check.service.js';

export function registerDockerHealthCheckRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(
    {
      ...containerHealthCheckRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const data = await service.getContainer(
        c.req.param('nodeId')!,
        decodeURIComponent(c.req.param('containerName')!)
      );
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...upsertContainerHealthCheckRoute,
      middleware: requireDockerContainerScope('docker:containers:edit', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const data = await service.upsertContainer(
        c.req.param('nodeId')!,
        decodeURIComponent(c.req.param('containerName')!),
        DockerHealthCheckUpsertSchema.parse(await c.req.json())
      );
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...testContainerHealthCheckRoute,
      middleware: requireDockerContainerScope('docker:containers:edit', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const body = await c.req.json().catch(() => null);
      const data = await service.testContainer(
        c.req.param('nodeId')!,
        decodeURIComponent(c.req.param('containerName')!),
        body ? DockerHealthCheckUpsertSchema.parse(body) : undefined
      );
      return c.json({ data });
    }
  );

  router.openapi(
    { ...deploymentHealthCheckRoute, middleware: requireDockerDeploymentScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const data = await service.getDeployment(c.req.param('nodeId')!, c.req.param('deploymentId')!);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...upsertDeploymentHealthCheckRoute, middleware: requireDockerDeploymentScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const data = await service.upsertDeployment(
        c.req.param('nodeId')!,
        c.req.param('deploymentId')!,
        DockerHealthCheckUpsertSchema.parse(await c.req.json())
      );
      return c.json({ data });
    }
  );

  router.openapi(
    { ...testDeploymentHealthCheckRoute, middleware: requireDockerDeploymentScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerHealthCheckService);
      const body = await c.req.json().catch(() => null);
      const data = await service.testDeployment(
        c.req.param('nodeId')!,
        c.req.param('deploymentId')!,
        body ? DockerHealthCheckUpsertSchema.parse(body) : undefined
      );
      return c.json({ data });
    }
  );
}
