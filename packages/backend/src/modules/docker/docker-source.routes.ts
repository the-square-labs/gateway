import type { OpenAPIHono as OpenAPIHonoType } from '@hono/zod-openapi';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerComposeProjects, dockerDeployments } from '@/db/schema/index.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { demoRestriction, isDemoMode } from '@/modules/demo/demo-mode.js';
import { ComposeProjectNameSchema } from '@/modules/docker/compose/compose.schemas.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv, User } from '@/types.js';
import { createDockerSourceResourceRoute, getDockerBuildAdmissionRoute } from './docker.docs.js';
import { DockerManagementService } from './docker.service.js';
import { requireDockerContainerScope } from './docker-access.middleware.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingConfigSchema,
  DockerSourceBindingUpsertSchema,
  DockerSourceResourceCreateSchema,
  type DockerSourceTarget,
} from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { DockerSourceService } from './docker-source.service.js';

const SourceBindingIdSchema = z.string().uuid();
const SOURCE_WEBHOOK_BODY_MAX_BYTES = 1_048_576;
const PENDING_SOURCE_IMAGE = 'gateway.invalid/pending-source-build:latest';
const ComposeSourceProjectCreateSchema = z
  .object({
    projectName: ComposeProjectNameSchema,
    source: DockerSourceBindingConfigSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.source.composeFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'composeFilePath'],
        message: 'Compose file path is required',
      });
    }
  });

function actorFor(c: {
  get(name: 'user'): User | undefined;
  get(name: 'effectiveScopes'): string[] | undefined;
}): User {
  const user = c.get('user');
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return { ...user, scopes: c.get('effectiveScopes') ?? user.scopes };
}

function containerTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return {
    kind: 'container',
    nodeId: c.req.param('nodeId')!,
    containerName: decodeURIComponent(c.req.param('containerName')!),
  };
}

function deploymentTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return { kind: 'deployment', deploymentId: c.req.param('deploymentId')! };
}

function composeTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return { kind: 'compose_project', composeProjectId: c.req.param('projectId')! };
}

export function assertDockerSourceTargetNode(
  requestedNodeId: string,
  actualNodeId: string | undefined,
  resource: 'compose' | 'deployment'
): void {
  if (actualNodeId === requestedNodeId) return;
  if (resource === 'compose') {
    throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
  }
  throw new AppError(404, 'NOT_FOUND', 'Deployment not found');
}

function requireComposeSourceScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const projectId = c.req.param('projectId');
    if (!nodeId || !projectId) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    const [project] = await (container.resolve(TOKENS.DrizzleClient) as DrizzleClient)
      .select({ nodeId: dockerComposeProjects.nodeId })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, projectId))
      .limit(1);
    assertDockerSourceTargetNode(nodeId, project?.nodeId, 'compose');
    if (!hasDockerResourceScope(c.get('effectiveScopes') || [], scope, nodeId, projectId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await next();
  };
}

function requireDeploymentSourceScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const deploymentId = c.req.param('deploymentId');
    if (!nodeId || !deploymentId) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    const [deployment] = await (container.resolve(TOKENS.DrizzleClient) as DrizzleClient)
      .select({ nodeId: dockerDeployments.nodeId })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, deploymentId))
      .limit(1);
    assertDockerSourceTargetNode(nodeId, deployment?.nodeId, 'deployment');
    if (!hasDockerResourceScope(c.get('effectiveScopes') || [], scope, nodeId, deploymentId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await next();
  };
}

export function registerDockerSourceRoutes(router: OpenAPIHonoType<AppEnv>) {
  router.get('/sources/connectors/:connectorId/repositories', requireScopeBase('docker:containers:view'), async (c) => {
    const data = await container
      .resolve(IntegrationsService)
      .listDockerBuildSourceRepositories(actorFor(c), c.req.param('connectorId'));
    return c.json({ data });
  });

  router.openapi(
    {
      ...getDockerBuildAdmissionRoute,
      middleware: requireScopeForResource('docker:containers:create', 'nodeId'),
    },
    async (c) => c.json({ data: await container.resolve(DockerBuildService).admissionStatus() })
  );

  router.openapi(
    {
      ...createDockerSourceResourceRoute,
      middleware: requireScopeForResource('docker:containers:create', 'nodeId'),
    },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('git-push-to-deploy');
      const nodeId = z.string().uuid().parse(c.req.param('nodeId'));
      const input = DockerSourceResourceCreateSchema.parse(await c.req.json());
      const actor = actorFor(c);
      const sourceService = container.resolve(DockerSourceService);
      const deploymentService = container.resolve(DockerDeploymentService);
      let target: DockerSourceTarget;
      let initialConfig: Record<string, unknown> | null = null;
      let pendingDeploymentId: string | null = null;

      if (input.resource.kind === 'deployment') {
        const deployment = await deploymentService.createPending(
          nodeId,
          { ...input.resource, image: PENDING_SOURCE_IMAGE },
          actor.id,
          actor.scopes
        );
        pendingDeploymentId = deployment.id;
        target = { kind: 'deployment', deploymentId: deployment.id };
      } else {
        const containers = await container.resolve(DockerManagementService).listContainers(nodeId);
        const existing = Array.isArray(containers)
          ? containers.some((candidate: any) => {
              const name = String(candidate.name ?? candidate.Name ?? '').replace(/^\//, '');
              return name === input.resource.name;
            })
          : false;
        if (existing) {
          throw new AppError(409, 'CONTAINER_NAME_CONFLICT', 'A container with this name already exists');
        }
        target = { kind: 'container', nodeId, containerName: input.resource.name };
        const { kind: _kind, ...config } = input.resource;
        initialConfig = config;
      }

      try {
        const source = await sourceService.upsert({ ...input.source, target }, actor, {
          allowMissingTarget: input.resource.kind === 'container',
          initialConfig,
        });
        const queued = await sourceService.createBuild(target, { force: false }, actor);
        return c.json({ data: { source, build: queued.build, target } }, 201);
      } catch (error) {
        await sourceService.remove(target, actor.id).catch(() => false);
        if (pendingDeploymentId) {
          await deploymentService.discardPending(nodeId, pendingDeploymentId).catch(() => false);
        }
        throw error;
      }
    }
  );

  router.get(
    '/nodes/:nodeId/containers/:containerName/source',
    requireDockerContainerScope('docker:containers:view', 'containerName'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).get(containerTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/containers/:containerName/source',
    requireDockerContainerScope('docker:containers:edit', 'containerName'),
    async (c) => {
      const config = DockerSourceBindingConfigSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsert({ ...config, target: containerTarget(c) }, actorFor(c));
      return c.json({ data });
    }
  );
  router.post(
    '/nodes/:nodeId/containers/:containerName/source/resolve',
    requireDockerContainerScope('docker:containers:edit', 'containerName'),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(containerTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/containers/:containerName/source/builds',
    requireDockerContainerScope('docker:containers:manage', 'containerName'),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(containerTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  router.get(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets',
    requireDockerContainerScope('docker:containers:view', 'containerName'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(containerTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets/:secretName',
    requireDockerContainerScope('docker:containers:edit', 'containerName'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(containerTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets/:secretName',
    requireDockerContainerScope('docker:containers:edit', 'containerName'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(containerTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/containers/:containerName/source',
    requireDockerContainerScope('docker:containers:edit', 'containerName'),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(containerTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );

  router.get(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).get(deploymentTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const config = DockerSourceBindingConfigSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsert({ ...config, target: deploymentTarget(c) }, actorFor(c));
      return c.json({ data });
    }
  );
  router.post(
    '/nodes/:nodeId/deployments/:deploymentId/source/resolve',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(deploymentTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/deployments/:deploymentId/source/builds',
    requireDeploymentSourceScope('docker:containers:manage'),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(deploymentTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  router.get(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets',
    requireDeploymentSourceScope('docker:containers:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(deploymentTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets/:secretName',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(deploymentTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets/:secretName',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(deploymentTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(deploymentTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );

  router.post(
    '/nodes/:nodeId/compose-projects/from-source',
    requireScopeForResource('docker:compose:create', 'nodeId'),
    async (c) => {
      const nodeId = z.string().uuid().parse(c.req.param('nodeId'));
      const input = ComposeSourceProjectCreateSchema.parse(await c.req.json());
      const actor = actorFor(c);
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
      const composeService = container.resolve(DockerComposeService);
      const sourceService = container.resolve(DockerSourceService);
      const project = await composeService.createPendingGitProject(nodeId, input.projectName, actor.id);
      const target = { kind: 'compose_project' as const, composeProjectId: project.id };
      try {
        const source = await sourceService.upsert({ ...input.source, target }, actor);
        const queued = await sourceService.createBuild(target, { force: false }, actor);
        return c.json({ data: { project, source, ...queued } }, 201);
      } catch (error) {
        await sourceService.remove(target, actor.id).catch(() => false);
        await composeService.discardPendingGitProject(project.id).catch(() => false);
        throw error;
      }
    }
  );

  router.get(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).get(composeTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
      const input = DockerSourceBindingUpsertSchema.parse({ ...(await c.req.json()), target: composeTarget(c) });
      const data = await container.resolve(DockerSourceService).upsert(input, actorFor(c));
      return c.json({ data });
    }
  );
  router.post(
    '/nodes/:nodeId/compose-projects/:projectId/source/resolve',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(composeTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/compose-projects/:projectId/source/builds',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(composeTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  router.get(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets',
    requireComposeSourceScope('docker:compose:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(composeTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets/:secretName',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(composeTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets/:secretName',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(composeTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(composeTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
}

export const dockerSourceWebhookRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

dockerSourceWebhookRoutes.use('*', async (_c, next) => {
  if (isDemoMode()) throw demoRestriction('Trigger source automation through a webhook');
  await next();
});

dockerSourceWebhookRoutes.post('/:sourceBindingId', async (c) => {
  const sourceBindingId = SourceBindingIdSchema.parse(c.req.param('sourceBindingId'));
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  if (rawBody.byteLength > SOURCE_WEBHOOK_BODY_MAX_BYTES) {
    throw new AppError(413, 'SOURCE_WEBHOOK_BODY_TOO_LARGE', 'Source webhook body exceeds 1 MiB');
  }
  const data = await container.resolve(DockerSourceService).handleWebhook(sourceBindingId, c.req.raw.headers, rawBody);
  return c.json({ data }, data.duplicate ? 200 : 202);
});
