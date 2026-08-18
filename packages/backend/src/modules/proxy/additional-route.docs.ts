import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { CreateAdditionalRouteSchema, UpdateAdditionalRouteSchema } from './additional-route.validation.js';

export const listAdditionalRoutesRoute = appRoute({
  method: 'get',
  path: '/{id}/additional-routes',
  tags: ['Routes'],
  summary: 'List managed Additional Routes for an ingress route',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createAdditionalRouteRoute = appRoute({
  method: 'post',
  path: '/{id}/additional-routes',
  tags: ['Routes'],
  summary: 'Create a managed Additional Route',
  request: { params: IdParamSchema, ...jsonBody(CreateAdditionalRouteSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const getAdditionalRouteRoute = appRoute({
  method: 'get',
  path: '/{id}/additional-routes/{routeId}',
  tags: ['Routes'],
  summary: 'Get a managed Additional Route',
  request: { params: pathParamSchema('id', 'routeId') },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAdditionalRouteRoute = appRoute({
  method: 'put',
  path: '/{id}/additional-routes/{routeId}',
  tags: ['Routes'],
  summary: 'Update a managed Additional Route',
  request: {
    params: pathParamSchema('id', 'routeId'),
    ...jsonBody(UpdateAdditionalRouteSchema),
  },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAdditionalRouteRoute = appRoute({
  method: 'delete',
  path: '/{id}/additional-routes/{routeId}',
  tags: ['Routes'],
  summary: 'Delete a managed Additional Route',
  request: { params: pathParamSchema('id', 'routeId') },
  responses: { 204: { description: 'No content' } },
});

export const retryAdditionalRouteRoute = appRoute({
  method: 'post',
  path: '/{id}/additional-routes/{routeId}/retry',
  tags: ['Routes'],
  summary: 'Retry a failed managed Additional Route',
  request: { params: pathParamSchema('id', 'routeId') },
  responses: okJson(UnknownDataResponseSchema),
});
