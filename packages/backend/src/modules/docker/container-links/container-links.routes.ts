import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import {
  assertContainerLinkEitherEndViewAccess,
  assertContainerLinkSourceAccess,
  assertContainerLinkTargetAccess,
  assertContainerLinkViewAccess,
} from './container-link-access.js';
import {
  createContainerLinkRoute,
  deleteContainerLinkRoute,
  getContainerLinkRoute,
  getContainerLinkRuntimeRoute,
  listContainerLinksRoute,
} from './container-links.docs.js';
import { CreateContainerLinkSchema, ListContainerLinksQuerySchema } from './container-links.schemas.js';
import { ContainerLinksService } from './container-links.service.js';

function hasEnvironment(environment: { host?: string; port?: string; url?: string } | undefined): boolean {
  return Boolean(environment && Object.values(environment).some(Boolean));
}

/** REST surface of container links; MCP (manage_container_link) uses the same service and access checks. */
export function registerContainerLinkRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(listContainerLinksRoute, async (c) => {
    const query = ListContainerLinksQuerySchema.parse(c.req.query());
    const ref = { nodeId: query.nodeId, type: query.type, resourceId: query.resourceId };
    await assertContainerLinkViewAccess(c.get('effectiveScopes') || [], ref);
    const service = container.resolve(ContainerLinksService);
    const data =
      query.direction === 'incoming'
        ? await service.listIncoming(ref.nodeId, ref.type, ref.resourceId)
        : await service.listBySource(ref.nodeId, ref.type, ref.resourceId);
    return c.json({ data });
  });

  router.openapi(createContainerLinkRoute, async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const input = CreateContainerLinkSchema.parse(await c.req.json());
    await assertContainerLinkSourceAccess(
      scopes,
      { nodeId: input.sourceNodeId, type: input.sourceType, resourceId: input.sourceResourceId },
      { environment: hasEnvironment(input.environment) }
    );
    await assertContainerLinkTargetAccess(scopes, {
      nodeId: input.targetNodeId,
      type: input.targetType,
      resourceId: input.targetResourceId,
    });
    const data = await container.resolve(ContainerLinksService).create(input, user.id);
    return c.json({ data }, 201);
  });

  router.openapi(getContainerLinkRoute, async (c) => {
    const service = container.resolve(ContainerLinksService);
    const data = await service.get(c.req.param('id')!);
    await assertContainerLinkEitherEndViewAccess(c.get('effectiveScopes') || [], data);
    return c.json({ data });
  });

  router.openapi(getContainerLinkRuntimeRoute, async (c) => {
    const service = container.resolve(ContainerLinksService);
    const link = await service.get(c.req.param('id')!);
    await assertContainerLinkEitherEndViewAccess(c.get('effectiveScopes') || [], link);
    return c.json({ data: await service.getRuntime(link.id) });
  });

  router.openapi(deleteContainerLinkRoute, async (c) => {
    const user = c.get('user')!;
    const service = container.resolve(ContainerLinksService);
    const link = await service.get(c.req.param('id')!);
    await assertContainerLinkSourceAccess(c.get('effectiveScopes') || [], link.source, {
      environment: hasEnvironment(link.environment),
    });
    return c.json({ data: await service.delete(link.id, user.id) });
  });
}
