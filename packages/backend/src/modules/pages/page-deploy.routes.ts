import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { container } from '@/container.js';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import type { AppEnv } from '@/types.js';
import { CreatePageDeploymentSchema } from './deployments/page-deployment.schemas.js';
import {
  PAGE_UPLOAD_CHUNK_MAX_BYTES,
  PageDeploymentService,
  type PageDeployPrincipal,
} from './deployments/page-deployment.service.js';
import { PagePublicationService } from './tags/page-publication.service.js';
import { PageDeployTokenService } from './tokens/page-deploy-token.service.js';

const tags = ['Pages Deploy API'];
const UploadIdParamSchema = IdParamSchema;

const createDeploymentRoute = appRoute({
  method: 'post',
  path: '/deployments',
  tags,
  summary: 'Create a resumable static Deployment upload',
  request: jsonBody(CreatePageDeploymentSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

const uploadChunkRoute = appRoute({
  method: 'put',
  path: '/uploads/{id}/chunks',
  tags,
  summary: 'Append a Deployment archive chunk',
  request: {
    params: UploadIdParamSchema,
    headers: z.object({ 'upload-offset': z.coerce.number().int().min(0) }),
    body: { content: { 'application/octet-stream': { schema: z.any() } }, required: true },
  },
  responses: okJson(UnknownDataResponseSchema),
});

const finalizeUploadRoute = appRoute({
  method: 'post',
  path: '/uploads/{id}/finalize',
  tags,
  summary: 'Validate and store a Deployment archive',
  request: { params: UploadIdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const pageDeployRoutes = new OpenAPIHono<AppEnv>();

pageDeployRoutes.use('*', requireLicenseFeature('pages'));

pageDeployRoutes.use('*', async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer gwp_')) {
    const token = await container.resolve(PageDeployTokenService).validate(authorization.slice(7).trim());
    if (!token) throw new HTTPException(401, { message: 'Invalid or expired Page deploy token' });
    c.set('pageDeployAuth', { kind: 'deploy-token', token });
    await next();
    return;
  }
  await authMiddleware(c, async () => {
    const user = c.get('user');
    if (!user) throw new HTTPException(401, { message: 'Authentication required' });
    c.set('pageDeployAuth', {
      kind: 'user',
      userId: user.id,
      scopes: c.get('effectiveScopes') ?? [],
    });
    await next();
  });
});

pageDeployRoutes.openapi(createDeploymentRoute, async (c) => {
  const input = CreatePageDeploymentSchema.parse(await c.req.json());
  const principal = c.get('pageDeployAuth') as PageDeployPrincipal;
  if (principal.kind === 'user') {
    if (!hasScopeForResource(principal.scopes, 'pages:deploy', input.projectId)) {
      throw new AppError(403, 'PAGE_DEPLOY_FORBIDDEN', 'Missing pages:deploy for this Project');
    }
  } else {
    if (principal.token.projectId !== input.projectId) {
      throw new AppError(403, 'PAGE_DEPLOY_TOKEN_PROJECT_MISMATCH', 'Deploy token belongs to another Project');
    }
    container.resolve(PageDeployTokenService).assertTagAllowed(principal.token, input.tag);
  }
  const data = await container.resolve(PageDeploymentService).create(input, principal);
  return c.json({ data }, 201);
});

pageDeployRoutes.openapi(uploadChunkRoute, async (c) => {
  const principal = c.get('pageDeployAuth') as PageDeployPrincipal;
  const contentType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/octet-stream') {
    throw new AppError(415, 'PAGES_UPLOAD_CONTENT_TYPE_INVALID', 'Upload chunks require application/octet-stream');
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > PAGE_UPLOAD_CHUNK_MAX_BYTES) {
    throw new AppError(413, 'PAGES_UPLOAD_CHUNK_TOO_LARGE', 'Upload chunk exceeds 8 MiB');
  }
  const offset = Number(c.req.header('Upload-Offset'));
  const data = await container.resolve(PageDeploymentService).appendChunk(c.req.param('id')!, offset, bytes, principal);
  return c.json({ data });
});

pageDeployRoutes.openapi(finalizeUploadRoute, async (c) => {
  const principal = c.get('pageDeployAuth') as PageDeployPrincipal;
  const deployments = container.resolve(PageDeploymentService);
  const stored = await deployments.finalize(c.req.param('id')!, principal);
  await container.resolve(PagePublicationService).markDeploymentReady(stored.deployment.id);
  return c.json({ data: { deployment: await deployments.get(stored.deployment.id) } });
});
