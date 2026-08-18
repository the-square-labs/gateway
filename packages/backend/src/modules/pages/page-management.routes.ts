import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { appRoute, createdJson, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import type { AppEnv } from '@/types.js';
import { PageDeploymentListQuerySchema } from './deployments/page-deployment.schemas.js';
import { PageDeploymentService } from './deployments/page-deployment.service.js';
import { requirePagesEnabledForMutation } from './profile/page-enabled.middleware.js';
import { PageRetentionService } from './retention/page-retention.service.js';
import {
  PageRuntimeConfigTagParamSchema,
  ResetPageRuntimeConfigSchema,
  SavePageRuntimeConfigSchema,
} from './runtime-config/page-runtime-config.schemas.js';
import { PageRuntimeConfigService } from './runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from './tags/page-publication.service.js';
import { MovePageTagSchema, PageTagParamSchema } from './tags/page-tag.schemas.js';
import { PageTagService } from './tags/page-tag.service.js';
import { CreatePageDeployTokenSchema } from './tokens/page-deploy-token.schemas.js';
import { PageDeployTokenService } from './tokens/page-deploy-token.service.js';

const tags = ['Pages'];
const ProjectParamSchema = z.object({ projectId: z.string().uuid() });
const ProjectDeploymentParamSchema = ProjectParamSchema.extend({ deploymentId: z.string().uuid() });
const ProjectTokenParamSchema = ProjectParamSchema.extend({ tokenId: z.string().uuid() });
const PinPageDeploymentSchema = z.object({ pinned: z.boolean() });

export const pageManagementRoutes = new OpenAPIHono<AppEnv>();
pageManagementRoutes.use('*', authMiddleware);
pageManagementRoutes.use('*', requireLicenseFeature('pages'));
pageManagementRoutes.use('*', requirePagesEnabledForMutation);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/{projectId}/runtime-configs',
      tags,
      summary: 'List Page Project runtime configurations',
      request: { params: ProjectParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:view', 'projectId'),
  },
  async (c) => c.json({ data: await container.resolve(PageRuntimeConfigService).list(c.req.param('projectId')!) })
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'put',
      path: '/{projectId}/runtime-configs/default',
      tags,
      summary: 'Update the default Page Project runtime configuration',
      request: { params: ProjectParamSchema, ...jsonBody(SavePageRuntimeConfigSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:edit', 'projectId'),
  },
  async (c) => {
    const data = await container
      .resolve(PageRuntimeConfigService)
      .saveDefault(c.req.param('projectId')!, SavePageRuntimeConfigSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'put',
      path: '/{projectId}/runtime-configs/tags/{tagId}',
      tags,
      summary: 'Create or update a Page Tag runtime configuration override',
      request: { params: PageRuntimeConfigTagParamSchema, ...jsonBody(SavePageRuntimeConfigSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:edit', 'projectId'),
  },
  async (c) => {
    const data = await container
      .resolve(PageRuntimeConfigService)
      .saveTag(
        c.req.param('projectId')!,
        c.req.param('tagId')!,
        SavePageRuntimeConfigSchema.parse(await c.req.json()),
        c.get('user')!.id
      );
    return c.json({ data });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'delete',
      path: '/{projectId}/runtime-configs/tags/{tagId}',
      tags,
      summary: 'Reset a Page Tag runtime configuration to the default',
      request: { params: PageRuntimeConfigTagParamSchema, ...jsonBody(ResetPageRuntimeConfigSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:edit', 'projectId'),
  },
  async (c) => {
    const { expectedGeneration } = ResetPageRuntimeConfigSchema.parse(await c.req.json());
    const data = await container
      .resolve(PageRuntimeConfigService)
      .resetTag(c.req.param('projectId')!, c.req.param('tagId')!, expectedGeneration, c.get('user')!.id);
    return c.json({ data });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/{projectId}/deployments',
      tags,
      summary: 'List Page Project Deployments',
      request: { params: ProjectParamSchema, query: PageDeploymentListQuerySchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:view', 'projectId'),
  },
  async (c) => {
    const query = PageDeploymentListQuerySchema.parse({
      page: c.req.query('page'),
      limit: c.req.query('limit'),
    });
    return c.json(await container.resolve(PageDeploymentService).list(c.req.param('projectId')!, query));
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'patch',
      path: '/{projectId}/deployments/{deploymentId}/pin',
      tags,
      summary: 'Pin or unpin a Page Deployment',
      request: { params: ProjectDeploymentParamSchema, ...jsonBody(PinPageDeploymentSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:deployments:manage', 'projectId'),
  },
  async (c) => {
    const { pinned } = PinPageDeploymentSchema.parse(await c.req.json());
    const data = await container
      .resolve(PageRetentionService)
      .setPinned(c.req.param('projectId')!, c.req.param('deploymentId')!, pinned, c.get('user')!.id);
    return c.json({ data });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'delete',
      path: '/{projectId}/deployments/{deploymentId}',
      tags,
      summary: 'Delete an unreferenced Page Deployment',
      request: { params: ProjectDeploymentParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:deployments:manage', 'projectId'),
  },
  async (c) => {
    await container
      .resolve(PageRetentionService)
      .deleteDeployment(c.req.param('projectId')!, c.req.param('deploymentId')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/{projectId}/tags',
      tags,
      summary: 'List Page Project Tags',
      request: { params: ProjectParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:view', 'projectId'),
  },
  async (c) => c.json({ data: await container.resolve(PageTagService).list(c.req.param('projectId')!) })
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'put',
      path: '/{projectId}/tags/{tag}',
      tags,
      summary: 'Create or move a Page Project Tag',
      request: { params: PageTagParamSchema, ...jsonBody(MovePageTagSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:tags:manage', 'projectId'),
  },
  async (c) => {
    const data = await container
      .resolve(PagePublicationService)
      .moveUserTag(
        c.req.param('projectId')!,
        c.req.param('tag')!,
        MovePageTagSchema.parse(await c.req.json()).deploymentId,
        c.get('user')!.id
      );
    return c.json({ data });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'delete',
      path: '/{projectId}/tags/{tag}',
      tags,
      summary: 'Delete a Page Project Tag',
      request: { params: PageTagParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:tags:manage', 'projectId'),
  },
  async (c) => {
    await container.resolve(PageTagService).delete(c.req.param('projectId')!, c.req.param('tag')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/{projectId}/deployments/{deploymentId}',
      tags,
      summary: 'Get a Page Project Deployment',
      request: { params: ProjectDeploymentParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:view', 'projectId'),
  },
  async (c) =>
    c.json({
      data: await container
        .resolve(PageDeploymentService)
        .getForProject(c.req.param('projectId')!, c.req.param('deploymentId')!),
    })
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/{projectId}/tokens',
      tags,
      summary: 'List Page Project deploy tokens',
      request: { params: ProjectParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:tokens:manage', 'projectId'),
  },
  async (c) => c.json({ data: await container.resolve(PageDeployTokenService).list(c.req.param('projectId')!) })
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'post',
      path: '/{projectId}/tokens',
      tags,
      summary: 'Create a Page Project deploy token',
      request: { params: ProjectParamSchema, ...jsonBody(CreatePageDeployTokenSchema) },
      responses: createdJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:tokens:manage', 'projectId'),
  },
  async (c) => {
    const data = await container
      .resolve(PageDeployTokenService)
      .create(c.req.param('projectId')!, CreatePageDeployTokenSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data }, 201);
  }
);

pageManagementRoutes.openapi(
  {
    ...appRoute({
      method: 'delete',
      path: '/{projectId}/tokens/{tokenId}',
      tags,
      summary: 'Revoke a Page Project deploy token',
      request: { params: ProjectTokenParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScopeForResource('pages:tokens:manage', 'projectId'),
  },
  async (c) => {
    await container
      .resolve(PageDeployTokenService)
      .revoke(c.req.param('projectId')!, c.req.param('tokenId')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);
