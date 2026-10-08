import { z } from '@hono/zod-openapi';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson } from '@/lib/openapi.js';
import {
  CreateTokenResponseSchema,
  CreateTokenSchema,
  TokenResponseSchema,
  UpdateTokenSchema,
} from './tokens.schemas.js';

export const listTokensRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Tokens'],
  summary: 'List API tokens',
  responses: okJson(z.array(TokenResponseSchema)),
});

export const createTokenRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Tokens'],
  summary: 'Create an API token',
  request: jsonBody(CreateTokenSchema),
  responses: createdJson(CreateTokenResponseSchema),
});

export const renameTokenRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Tokens'],
  summary: 'Update an API token',
  request: { params: IdParamSchema, ...jsonBody(UpdateTokenSchema) },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const revokeTokenRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Tokens'],
  summary: 'Revoke an API token',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const tokenRegistryAccessRoute = appRoute({
  method: 'get',
  path: '/registry-access',
  tags: ['Tokens'],
  summary: 'Whether API tokens can be given internal registry access',
  description:
    'Internal registry access works through docker login on the external registry endpoint, so it is offered while external access to the internal registry is on.',
  responses: okJson(z.object({ externalAccessEnabled: z.boolean() })),
});
