import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { DockerBuildListQuerySchema, DockerBuildLogQuerySchema } from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';

const BuildIdSchema = z.string().uuid();
const BUILD_PAGE_SCAN_LIMIT = 200;
const BUILD_PAGE_SCAN_PASSES = 20;

interface DockerBuildCursor {
  createdAt: string;
  id: string;
}

function encodeBuildCursor(build: { createdAt: Date | string; id: string }) {
  return Buffer.from(
    JSON.stringify({
      createdAt: build.createdAt instanceof Date ? build.createdAt.toISOString() : build.createdAt,
      id: build.id,
    } satisfies DockerBuildCursor)
  ).toString('base64url');
}

function decodeBuildCursor(value?: string): DockerBuildCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DockerBuildCursor>;
    if (typeof decoded.createdAt !== 'string' || Number.isNaN(Date.parse(decoded.createdAt))) return null;
    if (typeof decoded.id !== 'string' || !BuildIdSchema.safeParse(decoded.id).success) return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function canAccessBuild(
  scopes: readonly string[],
  action: 'docker:containers:view' | 'docker:containers:manage',
  build: {
    target:
      | { kind: 'container'; nodeId: string; containerName: string }
      | { kind: 'deployment'; nodeId: string; deploymentId: string };
  }
) {
  const resourceId = build.target.kind === 'container' ? build.target.containerName : build.target.deploymentId;
  return hasDockerResourceScope([...scopes], action, build.target.nodeId, resourceId);
}

export function registerDockerBuildRoutes(router: OpenAPIHono<AppEnv>) {
  router.get('/builds', requireScopeBase('docker:containers:view'), async (c) => {
    const query = DockerBuildListQuerySchema.parse(c.req.query());
    const scopes = c.get('effectiveScopes') ?? [];
    const requestedCursor = decodeBuildCursor(query.cursor);
    if (query.cursor && !requestedCursor) {
      throw new AppError(400, 'INVALID_BUILD_CURSOR', 'Build cursor is invalid');
    }
    const service = container.resolve(DockerBuildService);
    const visible: Awaited<ReturnType<DockerBuildService['list']>> = [];
    let cursor = requestedCursor;
    let exhausted = false;
    let lastScanned: { createdAt: Date | string; id: string } | null = null;

    for (let pass = 0; pass < BUILD_PAGE_SCAN_PASSES && visible.length <= query.limit; pass += 1) {
      const rows = await service.list({
        sourceBindingId: query.sourceBindingId,
        builderNodeId: query.builderNodeId,
        status: query.status,
        provider: query.provider,
        branch: query.branch,
        search: query.search,
        beforeCreatedAt: cursor ? new Date(cursor.createdAt) : undefined,
        beforeId: cursor?.id,
        limit: BUILD_PAGE_SCAN_LIMIT,
      });
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const build of rows) {
        lastScanned = build;
        if (canAccessBuild(scopes, 'docker:containers:view', build)) visible.push(build);
        if (visible.length > query.limit) break;
      }
      if (visible.length > query.limit) break;
      if (rows.length < BUILD_PAGE_SCAN_LIMIT) {
        exhausted = true;
        break;
      }
      const tail = rows.at(-1)!;
      cursor = {
        createdAt: tail.createdAt instanceof Date ? tail.createdAt.toISOString() : tail.createdAt,
        id: tail.id,
      };
    }

    const data = visible.slice(0, query.limit);
    const nextCursor =
      visible.length > query.limit
        ? encodeBuildCursor(data.at(-1)!)
        : !exhausted && lastScanned
          ? encodeBuildCursor(lastScanned)
          : null;
    return c.json({ data, nextCursor });
  });

  router.get('/builds/:buildId', requireScopeBase('docker:containers:view'), async (c) => {
    const build = await container.resolve(DockerBuildService).get(BuildIdSchema.parse(c.req.param('buildId')));
    if (!canAccessBuild(c.get('effectiveScopes') ?? [], 'docker:containers:view', build)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing Docker resource view scope for this build');
    }
    return c.json({ data: build });
  });

  router.get('/builds/:buildId/logs', requireScopeBase('docker:containers:view'), async (c) => {
    const buildId = BuildIdSchema.parse(c.req.param('buildId'));
    const build = await container.resolve(DockerBuildService).get(buildId);
    if (!canAccessBuild(c.get('effectiveScopes') ?? [], 'docker:containers:view', build)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing Docker resource view scope for this build');
    }
    const query = DockerBuildLogQuerySchema.parse(c.req.query());
    const data = await container.resolve(DockerBuildService).listLogs(buildId, query.afterSequence, query.limit);
    return c.json({ data });
  });

  router.post('/builds/:buildId/cancel', requireScopeBase('docker:containers:manage'), async (c) => {
    const service = container.resolve(DockerBuildService);
    const buildId = BuildIdSchema.parse(c.req.param('buildId'));
    const build = await service.get(buildId);
    if (!canAccessBuild(c.get('effectiveScopes') ?? [], 'docker:containers:manage', build)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing Docker resource manage scope for this build');
    }
    const data = await service.requestCancellation(buildId, c.get('user')!.id);
    return c.json({ data });
  });

  router.post('/builds/:buildId/retry', requireScopeBase('docker:containers:manage'), async (c) => {
    const service = container.resolve(DockerBuildService);
    const buildId = BuildIdSchema.parse(c.req.param('buildId'));
    const build = await service.get(buildId);
    if (!canAccessBuild(c.get('effectiveScopes') ?? [], 'docker:containers:manage', build)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing Docker resource manage scope for this build');
    }
    const data = await service.retry(buildId, c.get('user')!.id);
    return c.json({ data }, 201);
  });
}
