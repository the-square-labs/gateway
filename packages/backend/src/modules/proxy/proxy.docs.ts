import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  CreateProxyHostSchema,
  ProxyHostListQuerySchema,
  ToggleProxyHostSchema,
  ToggleProxyMaintenanceSchema,
  UpdateProxyHostSchema,
  ValidateAdvancedConfigSchema,
} from './proxy.schemas.js';

const RenderedConfigResponseSchema = dataResponseSchema(
  ValidateAdvancedConfigSchema.pick({ snippet: true })
    .extend({
      rendered: ValidateAdvancedConfigSchema.shape.snippet,
    })
    .omit({ snippet: true })
);

export const listProxyHostsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Routes'],
  summary: 'List ingress routes',
  request: { query: ProxyHostListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Get ingress route details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags: ['Routes'],
  summary: 'Resolve ingress route by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostHealthHistoryRoute = appRoute({
  method: 'get',
  path: '/{id}/health-history',
  tags: ['Routes'],
  summary: 'Get ingress route health history',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createProxyHostRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Routes'],
  summary: 'Create an ingress route',
  request: jsonBody(CreateProxyHostSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateProxyHostRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Update an ingress route',
  request: { params: IdParamSchema, ...jsonBody(UpdateProxyHostSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteProxyHostRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Delete an ingress route',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const toggleProxyHostRoute = appRoute({
  method: 'post',
  path: '/{id}/toggle',
  tags: ['Routes'],
  summary: 'Enable or disable an ingress route',
  request: { params: IdParamSchema, ...jsonBody(ToggleProxyHostSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const toggleProxyMaintenanceRoute = appRoute({
  method: 'post',
  path: '/{id}/maintenance',
  tags: ['Routes'],
  summary: 'Enter or exit maintenance mode for an ingress route',
  request: { params: IdParamSchema, ...jsonBody(ToggleProxyMaintenanceSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const resyncProxyHostTlsRoute = appRoute({
  method: 'post',
  path: '/{id}/tls/resync',
  tags: ['Routes'],
  summary: 'Retry TLS deployment for an ingress route',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const renderedProxyConfigRoute = appRoute({
  method: 'get',
  path: '/{id}/rendered-config',
  tags: ['Routes'],
  summary: 'Get rendered nginx config for an ingress route',
  request: { params: IdParamSchema },
  responses: okJson(RenderedConfigResponseSchema),
});

export const validateProxyConfigRoute = appRoute({
  method: 'post',
  path: '/validate-config',
  tags: ['Routes'],
  summary: 'Validate advanced nginx config',
  request: jsonBody(ValidateAdvancedConfigSchema),
  responses: okJson(UnknownDataResponseSchema),
});
